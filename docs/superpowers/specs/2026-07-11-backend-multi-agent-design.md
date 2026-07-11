# Saidrix AI Tutor Backend — Multi-Agent Express Server Design

Date: 2026-07-11
Status: Approved & implemented (v1)

## Goal

A production-quality Express backend hosting cooperating AI agents that provide tutoring services. Agent responsibilities are not finalized, so adding a new agent must be cheap: one self-contained folder + graph wiring.

## Decisions

| Area | Choice | Why |
|---|---|---|
| Language | TypeScript (ESM, NodeNext) | Type safety across agent data flow |
| Framework | Express 5 | Async error propagation built in |
| Orchestration | LangGraph.js (`@langchain/langgraph`) | Graph-based multi-agent routing, streaming-ready |
| LLM | Provider-agnostic via LangChain adapters | `LLM_PROVIDER=anthropic\|openai\|google`, swap by env |
| Database | MongoDB + Mongoose | Flexible schema while agent design evolves |
| Auth | JWT (bcryptjs, 7d expiry) | Standard register/login from day one |
| Validation | Zod (requests + env) | Fail fast, clear messages |
| Logging | Pino + pino-http | Structured logs |
| Testing | Vitest + Supertest + mongodb-memory-server | Integration tests, LLM mocked |

## Architecture

- `src/agents/<agent-name>/` — **one folder per agent** (`index.ts`, `prompt.ts`, `<name>.node.ts`). First agent: `chat-agent`.
- `src/agents/llm.ts` — `getChatModel()` factory; only the selected provider's API key is required.
- `src/agents/graph.ts` — LangGraph `StateGraph(MessagesAnnotation)`; currently START → chatAgent → END. New agents = new folder + node + edges here.
- Layering: routes (zod validation) → controllers (thin) → services (business logic) → models/graph.
- Central error middleware: `ApiError` → `{success:false, message}`; unknown → 500.

## API

- `GET /health`
- `POST /api/auth/register` `{name,email,password}` → `{token,user}`
- `POST /api/auth/login` `{email,password}` → `{token,user}`
- `POST /api/chat` (Bearer) `{message, conversationId?}` → `{reply, conversationId}`
- `GET /api/chat/:conversationId` (Bearer, owner-only) → conversation with messages

## Data

- `User`: name, email (unique, lowercase), passwordHash, timestamps
- `Conversation`: userId (indexed ref), title, messages[{role: user|assistant, content, agent?, createdAt}]

## Security

helmet, cors, rate limit (60 req/min on /api), JWT bearer auth, bcrypt(10), request size limit 1mb, env validated at boot.

## Future (out of scope v1)

SSE streaming, additional agent nodes + conditional routing, roles/permissions, refresh tokens.
