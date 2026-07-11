import { Router } from "express";
import { z } from "zod";
import * as chatController from "../controller/chat.controller.js";
import { requireAuth } from "../middleware/auth.middleware.js";
import { validateBody } from "../middleware/validate.middleware.js";

const sendMessageSchema = z.object({
  message: z.string().min(1).max(8000),
  conversationId: z.string().optional(),
});

export const chatRouter = Router();

chatRouter.use(requireAuth);
chatRouter.post("/", validateBody(sendMessageSchema), chatController.sendMessage);
chatRouter.get("/:conversationId", chatController.getConversation);
