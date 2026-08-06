import type OpenAI from "openai";

/**
 * The web-search tool as the model sees it. Attached only when Tavily is
 * configured. See ../web-search.ts for the search call itself.
 */

export const webSearchTool: OpenAI.Chat.ChatCompletionFunctionTool = {
  type: "function",
  function: {
    name: "web_search",
    description:
      "Search the web for current, factual, or real-time information (news, prices, recent events, anything you may not know). Returns relevant sources.",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "A focused search query capturing what to look up.",
        },
      },
      required: ["query"],
    },
  },
};
