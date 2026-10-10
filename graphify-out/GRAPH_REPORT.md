# Graph Report - backend  (2026-10-08)

## Corpus Check
- 338 files · ~288,018 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 2437 nodes · 6025 edges · 165 communities (121 shown, 44 thin omitted)
- Extraction: 99% EXTRACTED · 1% INFERRED · 0% AMBIGUOUS · INFERRED: 56 edges (avg confidence: 0.72)
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `60196839`
- Run `git rev-parse HEAD` and compare to check if the graph is stale.
- Run `graphify update .` after code changes (no API cost).

## Community Hubs (Navigation)
- index.ts
- learnerProfile.service.ts
- CourseModel
- turnRegistry.ts
- setup-lecture.test.ts
- retriever.ts
- activeSelection.service.ts
- resources.ts
- schema.ts
- progress.service.ts
- assessment.service.ts
- intake.service.ts
- index.ts
- lecture-maker.test.ts
- workers.ts
- chat.service.ts
- intake.slots.ts
- stream.ts
- prompt.ts
- fixSvg.ts
- project.service.ts
- entitlements.ts
- projectGate.ts
- routine-tools.ts
- env.ts
- lecture.service.ts
- index.ts
- studentMemory.service.ts
- index.ts
- courseDetail.service.ts
- course.schema.ts
- browser.ts
- agent-tools.test.ts
- director.ts
- measure.ts
- index.ts
- UserModel
- language.ts
- verification.service.ts
- geometry.ts
- projectReview.service.ts
- billing.controller.ts
- expand.ts
- course-maker.test.ts
- llmGate.ts
- course-tools.ts
- codeRunner.service.ts
- contact.controller.ts
- compilerOptions
- mermaid.ts
- generator.ts
- course-maker-tools.ts
- auth.controller.ts
- devDependencies
- forcedToolCall.ts
- Functional Profile + Progress Tracking — Saidrix AI Tutor
- gen-font-metrics.ts
- project-tools.ts
- projectProgress.service.ts
- auth.service.ts
- scripts
- llm.ts
- request.ts
- index.ts
- lemonSqueezy.client.ts
- voice-room-dispatch.test.ts
- Architecture
- index.ts
- beats.ts
- registry.ts
- workspaceDemo.service.ts
- index.ts
- index.ts
- validate.middleware.ts
- auth.routes.ts
- prompt.ts
- ApiError
- voice.service.ts
- svg-audit.ts
- transform.ts
- types.ts
- requireOwnedLesson
- conversation.model.ts
- token.service.ts
- auth.middleware.ts
- package.json
- question-tools.ts
- isBillingEnabled
- chat-stream-destructive-cap.test.ts
- intake.test.ts
- project-review-api.test.ts
- Saidrix AI Tutor Backend — Multi-Agent Express Server Design
- dependencies
- tsconfig.build.json
- billing-checkout.test.ts
- intake.routes.ts
- usageEvent.model.ts
- progress.routes.ts
- billing-invoices-cancel.test.ts
- dump-mermaid-fixture.mjs
- lecture.routes.ts
- billing-webhook.test.ts
- paywall.test.ts
- LessonContext
- csrf.middleware.ts
- project.routes.ts
- chat-stream-tool-markup.test.ts
- course-path-planned.test.ts
- learner-chat-wiring.test.ts
- user.model.ts
- chat.routes.ts
- routine.routes.ts
- runner.routes.ts
- chat-proposal.test.ts
- chat-question.test.ts
- contact.test.ts
- lemonsqueezy-checkout-body.test.ts
- mailer-transport.test.ts
- adm-zip
- llm-gate-coverage.test.ts
- rag-embeddings.test.ts
- bcryptjs
- cookie-parser
- cors
- express-rate-limit
- fast-xml-parser
- helmet
- jsonwebtoken
- @langchain/anthropic
- @langchain/core
- @langchain/google-genai
- @langchain/langgraph
- @langchain/openai
- livekit-server-sdk
- mermaid
- mongodb-memory-server
- multer
- nodemailer
- nodemon
- openai
- @pinecone-database/pinecone
- pino
- playwright-core
- ws
- zod
- pino-pretty
- supertest
- @types/cookie-parser
- @types/express
- @types/ws
- typescript
- vitest
- backfill-ever-paid.mjs
- migrate-drop-banglish.mjs
- curriculum-search-quiet.test.ts

## God Nodes (most connected - your core abstractions)
1. `UserModel` - 54 edges
2. `ApiError` - 52 edges
3. `Env` - 46 edges
4. `formatZodIssues()` - 44 edges
5. `CourseModel` - 43 edges
6. `LlmDeps` - 31 edges
7. `err()` - 30 edges
8. `resolveLectureDeps()` - 28 edges
9. `runForcedToolCall()` - 27 edges
10. `Language` - 26 edges

## Surprising Connections (you probably didn't know these)
- `makeCourse()` --indirect_call--> `err()`  [INFERRED]
  src/agents/course-maker/index.ts → tests/llm-gate.test.ts
- `beatDeps()` --indirect_call--> `text()`  [INFERRED]
  tests/lecture-maker.test.ts → src/agents/knowledge-profiler/schema.ts
- `setupBeatDeps()` --indirect_call--> `text()`  [INFERRED]
  tests/setup-lecture.test.ts → src/agents/knowledge-profiler/schema.ts
- `launch()` --indirect_call--> `err()`  [INFERRED]
  src/agents/lecture-maker/browser.ts → tests/llm-gate.test.ts
- `inspectSvg()` --indirect_call--> `err()`  [INFERRED]
  src/agents/lecture-maker/browser.ts → tests/llm-gate.test.ts

## Import Cycles
- None detected.

## Communities (165 total, 44 thin omitted)

### Community 0 - "index.ts"
Cohesion: 0.06
Nodes (69): makeProjectRequirements(), buildRequirementsSystemPrompt(), buildRequirementsUserMessage(), ProjectContext, emitRequirementsTool, ProjectRequirements, projectRequirementsSchema, resolveReviewDeps() (+61 more)

### Community 1 - "learnerProfile.service.ts"
Cohesion: 0.05
Nodes (67): hasOpenAICompatProvider(), extractProfileFacts(), resolveDeps(), updateProfileFromChat(), buildExtractSystemPrompt(), buildExtractUserMessage(), buildExtractTool(), ExtractedFacts (+59 more)

### Community 2 - "CourseModel"
Cohesion: 0.05
Nodes (35): beatSchema, apiLimiter, app, jsonBoard, jsonLarge, jsonSmall, corsOrigins, CourseModel (+27 more)

### Community 3 - "turnRegistry.ts"
Cohesion: 0.06
Nodes (46): InputAttachment, portal(), attach(), authenticate(), ClientMessage, fail(), handleMessage(), onConnection() (+38 more)

### Community 4 - "setup-lecture.test.ts"
Cohesion: 0.06
Nodes (47): LectureProgressEvent, setupBlueprintSchema, webSearchTool, formatSearchForModel(), WebSearchOptions, WebSearchResult, load(), RESULT (+39 more)

### Community 5 - "retriever.ts"
Cohesion: 0.08
Nodes (44): CONTENT_DIR, findReadmes(), force, here, main(), relPath(), line(), isRagEnabled() (+36 more)

### Community 6 - "activeSelection.service.ts"
Cohesion: 0.09
Nodes (44): buildCourseRequest(), makePathCourse(), pathCourseAt(), createPathCourse(), listPaths(), LearningPath, LearningPathModel, learningPathSchema (+36 more)

### Community 7 - "resources.ts"
Cohesion: 0.09
Nodes (44): buildDownloadsBlock(), buildSystemPrompt(), buildUserMessage(), DOWNLOAD_BLOCKLIST, DownloadPick, DownloadsResult, FALLBACK_INTRO, gatherCandidates() (+36 more)

### Community 8 - "schema.ts"
Cohesion: 0.05
Nodes (43): assembledLectureSchema, baseBlockFields, BLOCK_PLAN_TYPES, calloutBlockSchema, chartBlockSchema, checklistBlockSchema, codeBlockSchema, COLOR_TOKENS (+35 more)

### Community 9 - "progress.service.ts"
Cohesion: 0.11
Nodes (34): Achievement, AchievementModel, achievementSchema, EnrollmentModel, QuizAttemptModel, StudySession, StudySessionModel, studySessionSchema (+26 more)

### Community 10 - "assessment.service.ts"
Cohesion: 0.09
Nodes (32): AnsweredQuestion, answerSchema, askedQuestionSchema, KnowledgeAssessment, KnowledgeAssessmentModel, knowledgeAssessmentSchema, profileSchema, appendRound() (+24 more)

### Community 11 - "intake.service.ts"
Cohesion: 0.14
Nodes (35): IntakeReport, INTAKE_STAGES, IntakeStageName, LearningIntakeModel, advanceFrom(), applyPatch(), Doc, donePayload() (+27 more)

### Community 12 - "index.ts"
Cohesion: 0.12
Nodes (31): retrieveLessonGrounding(), Beat, stampBeatIdsOntoBlocks(), classifyLesson(), budgetDemoTime(), pickDemoBlock(), appendResources(), buildBeats() (+23 more)

### Community 13 - "lecture-maker.test.ts"
Cohesion: 0.14
Nodes (29): buildLessonBlueprint(), buildSetupBlueprint(), LectureRole, LectureToolCallOptions, NOTE: this value is also the last fallback for the vision critic, resolveLectureDeps(), runForcedToolCall(), svgDefaultModel() (+21 more)

### Community 14 - "workers.ts"
Cohesion: 0.11
Nodes (26): attrValue(), InlineResult, inlineSvgStyles(), matches(), mergeStyle(), parseRules(), Rule, buildSetupWorkerSystemPrompt() (+18 more)

### Community 15 - "chat.service.ts"
Cohesion: 0.12
Nodes (29): chatAgentNode(), AgentStreamEvent, tutorGraph, AssessmentStart, IntakeStart, ProposedCourse, ConversationModel, assessmentHistorySuffix() (+21 more)

### Community 16 - "intake.slots.ts"
Cohesion: 0.12
Nodes (27): Foundation, FOUNDATION_ANSWERS, FOUNDATION_QUESTION, intakeStartedText(), LANGUAGE_QUESTION, OS_QUESTION, parseDailyMinutes(), parseFinishByDays() (+19 more)

### Community 17 - "stream.ts"
Cohesion: 0.13
Nodes (21): seen, buildChatAgentPrompt(), classifyCourseIntent(), CourseRoute, ForcedTool, forcedToolFor(), historyHasProposal(), isRoutineSetupAnswer() (+13 more)

### Community 18 - "prompt.ts"
Cohesion: 0.16
Nodes (28): AssembledBlock, demoCandidates(), describeBlock(), NOT_PICKABLE, PICKABLE, RawBeat, referenceIssues(), runBeatWorker() (+20 more)

### Community 19 - "fixSvg.ts"
Cohesion: 0.18
Nodes (25): containingRect(), FixResult, fixSvg(), stackCoincidentLabels(), withAttr(), INTER_ADVANCES, INTER_FALLBACK_ADVANCE, INTER_WEIGHTS (+17 more)

### Community 20 - "project.service.ts"
Cohesion: 0.11
Nodes (23): getMyProfileTool, getMyProgressTool, getMyProfile, getMyProgress, studentTools, Project, ProjectModel, projectSchema (+15 more)

### Community 21 - "entitlements.ts"
Cohesion: 0.11
Nodes (23): BILLING_PERIODS, BillingPeriod, Entitlements, hasAllVariants(), PLAN_BY_VARIANT, planForVariant(), PlanVariant, VARIANT_ENV_KEYS (+15 more)

### Community 22 - "projectGate.ts"
Cohesion: 0.09
Nodes (18): getProject(), listProjects(), Enrollment, enrollmentSchema, ProjectInput, allDone(), chapterLessonIds(), ChapterList (+10 more)

### Community 23 - "routine-tools.ts"
Cohesion: 0.09
Nodes (25): askRoutineSetupTool, buildRoutineSetupQuestions(), createRoutineItemsTool, createRoutineItemTool, deleteRoutineItemsTool, deleteRoutineItemTool, ITEM_PROPERTIES, listRoutineTool (+17 more)

### Community 24 - "env.ts"
Cohesion: 0.08
Nodes (13): client, configProblems, Env, envSchema, parsed, APPLY, pending, Row (+5 more)

### Community 25 - "lecture.service.ts"
Cohesion: 0.11
Nodes (26): LectureModel, LecturePosition, LecturePositionModel, lecturePositionSchema, assertLessonEnterable(), generateLectureForLesson(), GenerationJob, getLecturePosition() (+18 more)

### Community 26 - "index.ts"
Cohesion: 0.16
Nodes (24): buildProfile(), generateRound(), resolveProfilerDeps(), scoreDiagnostics(), buildProfileSystemPrompt(), buildProfileUserMessage(), buildRoundSystemPrompt(), buildRoundUserMessage() (+16 more)

### Community 27 - "studentMemory.service.ts"
Cohesion: 0.13
Nodes (20): ActivityLog, ActivityLogModel, activityLogSchema, QuizAttempt, quizAttemptSchema, recentForCourse(), buildStudentContext(), describeStudying() (+12 more)

### Community 28 - "index.ts"
Cohesion: 0.14
Nodes (20): FALLBACK_BACKGROUND_QUESTION, FALLBACK_GOAL_QUESTION, generateIntakePlan(), guessTopicShape(), resolveIntakeDeps(), buildPlanSystemPrompt(), buildPlanUserMessage(), emitIntakePlanTool (+12 more)

### Community 29 - "courseDetail.service.ts"
Cohesion: 0.12
Nodes (15): courseDetail(), creating, listCourses(), chapterSchema, Course, courseSchema, moduleSchema, quizSchema (+7 more)

### Community 30 - "course.schema.ts"
Cohesion: 0.13
Nodes (17): APPLY, changes, Row, rows, BRANDS, IconName, inferIcon(), refineIcon() (+9 more)

### Community 31 - "browser.ts"
Cohesion: 0.17
Nodes (20): acquire(), acquireLive(), closeBrowser(), FALLBACK_CHANNELS, getBrowser(), Inspection, InspectOptions, inspectSvg() (+12 more)

### Community 32 - "agent-tools.test.ts"
Cohesion: 0.14
Nodes (14): RoutineItem, RoutineItemModel, routineItemSchema, createRoutineItem(), createRoutineItems(), deleteRoutineItem(), deleteRoutineItems(), findOwned() (+6 more)

### Community 33 - "director.ts"
Cohesion: 0.14
Nodes (20): buildSystemPrompt(), buildUserMessage(), decideProbe(), decisionSchema, emitProbeDecisionTool, IntakeAnswer, ProbeContext, ProbeDecision (+12 more)

### Community 34 - "measure.ts"
Cohesion: 0.24
Nodes (18): labelOverflows(), quote(), rectCollisions(), textCollisions(), validateSvgCollisions(), area(), containingRect(), contains() (+10 more)

### Community 35 - "index.ts"
Cohesion: 0.17
Nodes (17): currentNarrative(), DistillableConversation, distillConversation(), distillMemory(), inFlight, resolveDeps(), toExchangeLines(), buildDistillSystemPrompt() (+9 more)

### Community 36 - "UserModel"
Cohesion: 0.23
Nodes (20): isTrialConfigured(), SubscriptionModel, UserModel, accessFor(), applySubscriptionState(), backfillInvoices(), cancelForUser(), currentPeriod() (+12 more)

### Community 37 - "language.ts"
Cohesion: 0.17
Nodes (19): intakeAlreadyDoneText(), unspeakableLanguageQuestion(), entry(), FALLBACK_SUGGESTIONS, hasTunedTurnDetection(), isSpeechSupported(), KNOWN_LANGUAGES, LANGUAGE_LABELS (+11 more)

### Community 38 - "verification.service.ts"
Cohesion: 0.20
Nodes (16): VERIFICATION_TYPES, VerificationToken, VerificationTokenModel, verificationTokenSchema, VerificationType, revokeAllRefreshTokens(), isPasswordResetTokenValid(), minutesFromNow() (+8 more)

### Community 39 - "geometry.ts"
Cohesion: 0.15
Nodes (14): ctx, elapsed, issues, planned, t0, FixOptions, GeometryOptions, validateSvgGeometry() (+6 more)

### Community 40 - "projectReview.service.ts"
Cohesion: 0.20
Nodes (17): ingestSubmission(), entitlementsFor(), issueSchema, ProjectReview, ProjectReviewModel, projectReviewSchema, requirementResultSchema, reviewedFileSchema (+9 more)

### Community 41 - "billing.controller.ts"
Cohesion: 0.17
Nodes (18): isBillingPeriod(), isPlanId(), cancel(), checkout(), INVOICE_EVENTS, invoices(), repairEmptyInvoiceHistory(), signatureMatches() (+10 more)

### Community 42 - "expand.ts"
Cohesion: 0.16
Nodes (13): CourseRole, CourseToolCallOptions, resolveCourseDeps(), runForcedToolCall(), expandChapter(), expandChapters(), SETUP_TEXT, buildExpandSystemPrompt() (+5 more)

### Community 43 - "course-maker.test.ts"
Cohesion: 0.15
Nodes (12): courseIdSuffix(), dedupeTitle(), rand4(), slugify(), ExpandedChapter, GeneratedCourse, Gen, mockExpand (+4 more)

### Community 44 - "llmGate.ts"
Cohesion: 0.20
Nodes (16): acquire(), blockAll(), describe(), gatedLlmCall(), is429(), isTransient(), limits(), prune() (+8 more)

### Community 45 - "course-tools.ts"
Cohesion: 0.14
Nodes (17): createArgs, createCourse, deleteArgs, deleteCourse, deleteCourses, deleteManyArgs, listCourses, organizeArgs (+9 more)

### Community 46 - "codeRunner.service.ts"
Cohesion: 0.19
Nodes (15): isCodeRunnerEnabled(), getLanguages(), b64(), base(), headers(), Judge0Result, languageId(), LANGUAGES (+7 more)

### Community 47 - "contact.controller.ts"
Cohesion: 0.24
Nodes (15): CATEGORY_LABELS, displayName(), headerSafe(), submit(), buttonBlock(), codeBlock(), EmailContent, escapeHtml() (+7 more)

### Community 48 - "compilerOptions"
Cohesion: 0.11
Nodes (17): ES2022, node, tests/**/*.ts, compilerOptions, esModuleInterop, forceConsistentCasingInFileNames, lib, module (+9 more)

### Community 49 - "mermaid.ts"
Cohesion: 0.18
Nodes (14): blocks, CTX, diagrams, kinds, marked, seen, started, checkMermaidBlocks() (+6 more)

### Community 50 - "generator.ts"
Cohesion: 0.18
Nodes (15): generateCoursePayload(), GeneratorDeps, resolveGeneratorDeps(), buildCourseMakerSystemPrompt(), buildFreshnessQuery(), cache, CacheEntry, cacheTtlMs() (+7 more)

### Community 51 - "course-maker-tools.ts"
Cohesion: 0.14
Nodes (13): Breadth, BREADTH_RANGE, BREADTHS, createPathArgs, createPathCourses, generateArgs, generateCourse, proposeArgs (+5 more)

### Community 52 - "auth.controller.ts"
Cohesion: 0.18
Nodes (10): login(), logout(), refresh(), register(), reqMeta(), clearRefreshCookie(), REFRESH_COOKIE_NAME, revokeRefreshToken() (+2 more)

### Community 53 - "devDependencies"
Cohesion: 0.12
Nodes (17): devDependencies, tsx, @types/adm-zip, @types/cors, @types/jsonwebtoken, @types/multer, @types/node, @types/nodemailer (+9 more)

### Community 54 - "forcedToolCall.ts"
Cohesion: 0.16
Nodes (14): TOOL, extract(), Extraction, ForcedToolCallOptions, REPAIR_TIMEOUT_MS, repairMessages(), runForcedToolCall(), base (+6 more)

### Community 55 - "Functional Profile + Progress Tracking — Saidrix AI Tutor"
Cohesion: 0.12
Nodes (15): Achievement (new) — awarded, one per (userId, key), Achievements evaluator, Data model, Decisions (approved), Endpoints, Enrollment (new) — one per user per course, Frontend, Functional Profile + Progress Tracking — Saidrix AI Tutor (+7 more)

### Community 56 - "gen-font-metrics.ts"
Cohesion: 0.16
Nodes (13): body, CHARS, fallbacks, measured, OUT, vertical, WEIGHTS, paletteCss() (+5 more)

### Community 57 - "project-tools.ts"
Cohesion: 0.17
Nodes (14): createArgs, createProject, deleteArgs, deleteManyArgs, deleteProject, deleteProjects, listProjects, updateArgs (+6 more)

### Community 58 - "projectProgress.service.ts"
Cohesion: 0.28
Nodes (12): ProjectProgress, ProjectProgressModel, projectProgressSchema, submissionSchema, archiveProject(), listMyProjects(), oid(), ownedProject() (+4 more)

### Community 59 - "auth.service.ts"
Cohesion: 0.21
Nodes (15): AuthTokens, checkUsernameAvailability(), checkUsernameFormat(), DUMMY_HASH, duplicateKeyField(), getUserById(), issueTokens(), login() (+7 more)

### Community 60 - "scripts"
Cohesion: 0.13
Nodes (15): scripts, build, dev, icons:backfill, ingest:knowledge, mermaid:fixture, migrate:active-paths, migrate:drop-banglish (+7 more)

### Community 61 - "llm.ts"
Cohesion: 0.21
Nodes (10): CritiqueContext, isCapabilityError(), REVIEW_TOOL, ReviewPayload, DEFAULT_MODELS, getChatModel(), getChatModelFor(), OPENAI_COMPAT (+2 more)

### Community 62 - "request.ts"
Cohesion: 0.18
Nodes (13): MadeCourse, CourseRequestArgs, PathCourseResult, CourseBrief, emitChapterTool, emitCourseTool, expandedChapterSchema, generatedCourseSchema (+5 more)

### Community 63 - "index.ts"
Cohesion: 0.25
Nodes (12): TIER_RANK, buildProjectPlanSystemPrompt(), buildProjectPlanUserMessage(), ProjectPlanContext, emitProjectPlanTool, PlannedProject, plannedProjectSchema, PROJECT_TIERS (+4 more)

### Community 64 - "lemonSqueezy.client.ts"
Cohesion: 0.14
Nodes (8): assertConfigured(), call(), CreateCheckoutInput, LsInvoice, LsInvoiceAttributes, LsResource, LsSubscription, LsSubscriptionAttributes

### Community 65 - "voice-room-dispatch.test.ts"
Cohesion: 0.13
Nodes (5): calls, dispatches, gateCalls, participants, rooms

### Community 66 - "Architecture"
Cohesion: 0.14
Nodes (13): Architecture, Data model, Decisions (approved), Endpoints (`/api/auth`), Frontend, Goal, Hardening (baseline), Industry-Level Authentication — Saidrix AI Tutor (+5 more)

### Community 67 - "index.ts"
Cohesion: 0.25
Nodes (11): countLessons(), enforceLessonCap(), insertSetupLesson(), toCourseInput(), makeCourse(), resolveUnlockLesson(), summarizeCoverage(), OrderedProject (+3 more)

### Community 68 - "beats.ts"
Cohesion: 0.14
Nodes (13): BEAT_CHECK_MODES, BEAT_CHECK_WEIGHTS, BEAT_DEMO_KINDS, BEAT_PROBE_WORTH, BeatCheckMode, beatEmissionSchema, BeatMisconception, beatsSchema (+5 more)

### Community 69 - "registry.ts"
Cohesion: 0.16
Nodes (10): courseContentSearchToolDef, Level, courseMakerTools, courseTools, projectTools, courseContentSearchTool, DB_TOOLS, webSearchTool (+2 more)

### Community 70 - "workspaceDemo.service.ts"
Cohesion: 0.21
Nodes (12): WorkspaceDemo, WorkspaceDemoModel, workspaceDemoSchema, workspaceStepSchema, SUPPORTED_LANGUAGES, assertTeachable(), createWorkspaceDemo(), getWorkspaceDemo() (+4 more)

### Community 71 - "index.ts"
Cohesion: 0.18
Nodes (10): billingRouter, contactLimiter, contactRouter, contactSchema, courseRouter, setActiveSchema, paid, createSessionSchema (+2 more)

### Community 72 - "index.ts"
Cohesion: 0.28
Nodes (9): FILES, here, lecturesDir, connectDatabase(), disconnectDatabase(), ensureUserIndexes(), main(), attachChatSocket() (+1 more)

### Community 73 - "validate.middleware.ts"
Cohesion: 0.22
Nodes (6): validateBody(), assessmentRouter, boardRouter, boardSchema, SubmitRoundBody, submitRoundSchema

### Community 74 - "auth.routes.ts"
Cohesion: 0.21
Nodes (11): authLimiter, lookupLimiter, lookupSustainedLimiter, sessionLimiter, authRouter, forgotPasswordSchema, loginSchema, passwordSchema (+3 more)

### Community 75 - "prompt.ts"
Cohesion: 0.30
Nodes (9): buildCourseMakerUserMessage(), buildExpandUserMessage(), buildPathBoundary(), intakeLines(), profileLines(), languageInstruction(), COURSES, mockMakeCourse (+1 more)

### Community 76 - "ApiError"
Cohesion: 0.21
Nodes (4): errorHandler(), notFoundHandler(), ApiError, logger

### Community 77 - "voice.service.ts"
Cohesion: 0.24
Nodes (9): getLectureByLessonId(), assertCapacity(), createVoiceSession(), dispatchService, ensureTutorDispatched(), isAgent(), livekitHost, roomService (+1 more)

### Community 78 - "svg-audit.ts"
Cohesion: 0.18
Nodes (10): Drift, drifts, Fixture, FIXTURES, missing, texts, worst, RawMeasurement (+2 more)

### Community 79 - "transform.ts"
Cohesion: 0.29
Nodes (10): decodeEntities(), applyBox(), applyPoint(), args(), IDENTITY, Matrix, multiply(), parseTransform() (+2 more)

### Community 80 - "types.ts"
Cohesion: 0.24
Nodes (9): FreshContext, intakeTools, startArgs, startLearningIntake, failure(), invalidArgs(), ToolContext, ToolOutcome (+1 more)

### Community 82 - "requireOwnedLesson"
Cohesion: 0.27
Nodes (9): Board, BoardModel, boardSchema, BoardSnapshot, getBoard(), saveBoard(), DEMO_LESSON_IDS, gradeLectureQuiz() (+1 more)

### Community 83 - "conversation.model.ts"
Cohesion: 0.18
Nodes (10): actionSchema, askQuestionSchema, assessmentStartSchema, attachmentSchema, Conversation, conversationSchema, intakeStartSchema, messageSchema (+2 more)

### Community 84 - "token.service.ts"
Cohesion: 0.24
Nodes (9): RefreshToken, RefreshTokenModel, refreshTokenSchema, ACCESS_ALG, AccessPayload, ISSUER_APP, ISSUER_VOICE_AGENT, issueRefreshToken() (+1 more)

### Community 85 - "auth.middleware.ts"
Cohesion: 0.33
Nodes (10): AuthUser, bearer(), Express, optionalAuth(), Request, requireAuth(), requireAuthOrVoiceAgent(), decode() (+2 more)

### Community 86 - "package.json"
Cohesion: 0.20
Nodes (9): author, description, engines, node, license, main, name, type (+1 more)

### Community 87 - "question-tools.ts"
Cohesion: 0.27
Nodes (8): askQuestionsTool, askArgs, askQuestions, deriveHeader(), normalizeQuestions(), questionTools, str(), RegisteredTool

### Community 88 - "isBillingEnabled"
Cohesion: 0.33
Nodes (8): trialDays(), isBillingEnabled(), requireActivePlan(), configRouter, appOpenFor(), effectiveStatus(), hasAccess(), sessionStatus()

### Community 90 - "chat-stream-destructive-cap.test.ts"
Cohesion: 0.20
Nodes (4): deleteRoutineItemsTool, deleteRoutineItemTool, mocks, ToolResult

### Community 91 - "intake.test.ts"
Cohesion: 0.31
Nodes (8): auth(), completeIntake(), mockPlan, mockProbe, mockReport, post(), startIntakeViaTool(), walk()

### Community 92 - "project-review-api.test.ts"
Cohesion: 0.24
Nodes (8): auth(), createProject(), ingestSubmission, makeProjectRequirements, pollUntilSettled(), REQUIREMENTS, RESULT, reviewProject

### Community 93 - "Saidrix AI Tutor Backend — Multi-Agent Express Server Design"
Cohesion: 0.22
Nodes (8): API, Architecture, Data, Decisions, Future (out of scope v1), Goal, Saidrix AI Tutor Backend — Multi-Agent Express Server Design, Security

### Community 94 - "dependencies"
Cohesion: 0.22
Nodes (9): dotenv, express, mongoose, dependencies, dotenv, express, mongoose, pino-http (+1 more)

### Community 95 - "tsconfig.build.json"
Cohesion: 0.22
Nodes (8): ./tsconfig.json, compilerOptions, noEmit, outDir, rootDir, extends, include, src/**/*.ts

### Community 96 - "billing-checkout.test.ts"
Cohesion: 0.28
Nodes (7): createCheckout, getSubscription, listSubscriptionInvoices, releaseCheckoutLock(), skippedTrial(), sold(), soldVariant()

### Community 97 - "intake.routes.ts"
Cohesion: 0.36
Nodes (3): intakeRouter, SubmitStageBody, submitStageSchema

### Community 98 - "usageEvent.model.ts"
Cohesion: 0.25
Nodes (6): USAGE_KINDS, UsageEvent, UsageEventModel, usageEventSchema, UsageKind, generatedAt()

### Community 99 - "progress.routes.ts"
Cohesion: 0.29
Nodes (6): completeLessonSchema, enrollSchema, progressRouter, studyTimeSchema, submitProjectSchema, voiceAgentProgressRouter

### Community 101 - "dump-mermaid-fixture.mjs"
Cohesion: 0.33
Nodes (5): bundle, edgeIds, nodeIds, OUT, require

### Community 102 - "lecture.routes.ts"
Cohesion: 0.33
Nodes (5): lectureRouter, positionSchema, submitQuizSchema, voiceAgentLectureRouter, workspaceDemoSchema

### Community 104 - "paywall.test.ts"
Cohesion: 0.33
Nodes (4): GATED, OPEN, setPlanState(), withTrial()

### Community 105 - "LessonContext"
Cohesion: 0.40
Nodes (5): DownloadsInput, LessonContext, ResourcesInput, LessonBlueprint, SetupBlueprint

### Community 106 - "csrf.middleware.ts"
Cohesion: 0.50
Nodes (4): requireCsrf(), CSRF_COOKIE_NAME, CSRF_HEADER_NAME, timingSafeEqualStr()

### Community 107 - "project.routes.ts"
Cohesion: 0.40
Nodes (4): createProjectSchema, projectRouter, updateProjectSchema, uploadZip

### Community 108 - "chat-stream-tool-markup.test.ts"
Cohesion: 0.60
Nodes (4): answerFor(), asyncIterableOf(), chunk(), mocks

### Community 111 - "user.model.ts"
Cohesion: 0.50
Nodes (3): PREFERRED_LANGUAGES, User, userSchema

### Community 112 - "chat.routes.ts"
Cohesion: 0.50
Nodes (3): attachmentSchema, chatRouter, sendMessageSchema

### Community 113 - "routine.routes.ts"
Cohesion: 0.50
Nodes (3): createSchema, routineRouter, updateSchema

### Community 114 - "runner.routes.ts"
Cohesion: 0.50
Nodes (3): runLimiter, runnerRouter, runSchema

### Community 119 - "mailer-transport.test.ts"
Cohesion: 0.50
Nodes (3): savedEnv, smtp, SMTP_ENV

### Community 120 - "adm-zip"
Cohesion: 0.67
Nodes (3): adm-zip, adm-zip, zipOf()

## Knowledge Gaps
- **695 isolated node(s):** `name`, `version`, `description`, `license`, `author` (+690 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **44 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `ApiError` connect `ApiError` to `index.ts`, `learnerProfile.service.ts`, `CourseModel`, `turnRegistry.ts`, `activeSelection.service.ts`, `progress.service.ts`, `assessment.service.ts`, `intake.service.ts`, `index.ts`, `lecture-maker.test.ts`, `chat.service.ts`, `project.service.ts`, `projectGate.ts`, `lecture.service.ts`, `index.ts`, `courseDetail.service.ts`, `agent-tools.test.ts`, `UserModel`, `verification.service.ts`, `projectReview.service.ts`, `billing.controller.ts`, `expand.ts`, `course-maker.test.ts`, `codeRunner.service.ts`, `generator.ts`, `auth.controller.ts`, `forcedToolCall.ts`, `projectProgress.service.ts`, `auth.service.ts`, `llm.ts`, `request.ts`, `lemonSqueezy.client.ts`, `index.ts`, `workspaceDemo.service.ts`, `validate.middleware.ts`, `voice.service.ts`, `requireOwnedLesson`, `auth.middleware.ts`, `isBillingEnabled`, `csrf.middleware.ts`?**
  _High betweenness centrality (0.128) - this node is a cross-community bridge._
- **Why does `zipOf()` connect `adm-zip` to `index.ts`?**
  _High betweenness centrality (0.067) - this node is a cross-community bridge._
- **Why does `dependencies` connect `dependencies` to `helmet`, `jsonwebtoken`, `@langchain/anthropic`, `@langchain/core`, `@langchain/google-genai`, `@langchain/langgraph`, `@langchain/openai`, `livekit-server-sdk`, `mermaid`, `multer`, `nodemailer`, `openai`, `@pinecone-database/pinecone`, `pino`, `playwright-core`, `ws`, `zod`, `package.json`, `adm-zip`, `bcryptjs`, `cookie-parser`, `cors`, `express-rate-limit`, `fast-xml-parser`?**
  _High betweenness centrality (0.067) - this node is a cross-community bridge._
- **What connects `name`, `version`, `description` to the rest of the system?**
  _695 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `index.ts` be split into smaller, more focused modules?**
  _Cohesion score 0.06165099268547544 - nodes in this community are weakly interconnected._
- **Should `learnerProfile.service.ts` be split into smaller, more focused modules?**
  _Cohesion score 0.0519219736087206 - nodes in this community are weakly interconnected._
- **Should `CourseModel` be split into smaller, more focused modules?**
  _Cohesion score 0.04504504504504504 - nodes in this community are weakly interconnected._