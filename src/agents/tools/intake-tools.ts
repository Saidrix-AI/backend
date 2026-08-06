import { z } from "zod";
import { findReusableIntake, startIntake } from "../../services/intake.service.js";
import { intakeAlreadyDoneText, intakeStartedText, startLearningIntakeTool } from "./prompts/intake.js";
import { failure, invalidArgs, type RegisteredTool } from "./types.js";

const startArgs = z.object({
  topic: z.string().min(1).max(120),
  objective: z.string().min(1).max(500),
  scope: z.enum(["single", "multi"]).default("single"),
});

const startLearningIntake: RegisteredTool = {
  schema: startLearningIntakeTool,
  runningLabel: (a) => `Setting up your learning plan for ${String(a.topic ?? "this topic").slice(0, 60)}`,
  run: async (ctx, args) => {
    const parsed = startArgs.safeParse(args);
    if (!parsed.success) return invalidArgs("Couldn't start the setup", parsed.error);
    try {
      // Re-interviewing someone who answered 20 questions about THIS topic
      // minutes ago is just rude — but a different topic needs its own goal,
      // language and knowledge check, so the match is on the topic, not on
      // "has this student ever done an intake".
      const reusable = await findReusableIntake(ctx.userId, parsed.data.topic).catch(() => null);
      if (reusable) {
        return {
          ok: true,
          label: "Using your recent setup",
          modelText: intakeAlreadyDoneText(reusable),
        };
      }

      const payload = await startIntake(ctx.userId, parsed.data);
      return {
        ok: true,
        label: `Guided setup started (${payload.totalStages} steps)`,
        modelText: intakeStartedText(payload.stageLabel, payload.totalStages),
        intake: payload,
      };
    } catch (err) {
      return failure("Couldn't start the setup", err);
    }
  },
};

export const intakeTools = [startLearningIntake];
