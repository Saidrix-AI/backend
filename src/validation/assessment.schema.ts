import { z } from "zod";

export const submitRoundSchema = z.object({
  round: z.number().int().min(1).max(10),
  answers: z
    .array(z.object({ answer: z.string().min(1).max(400) }))
    .min(1)
    .max(8),
});
export type SubmitRoundBody = z.infer<typeof submitRoundSchema>;
