import { Router } from "express";
import { z } from "zod";
import * as chatController from "../controller/chat.controller.js";
import { requireAuth } from "../middleware/auth.middleware.js";
import { validateBody } from "../middleware/validate.middleware.js";

const attachmentSchema = z.object({
  name: z.string().min(1).max(200),
  mimeType: z.string().min(1).max(100),
  kind: z.enum(["image", "text"]),
  // data URL for images (base64), raw text for text files
  data: z.string().min(1).max(6_000_000),
});

const sendMessageSchema = z.object({
  message: z.string().min(1).max(8000),
  conversationId: z.string().optional(),
  webSearch: z.boolean().optional(),
  attachments: z.array(attachmentSchema).max(3).optional(),
});

export const chatRouter = Router();

chatRouter.use(requireAuth);
chatRouter.post("/", validateBody(sendMessageSchema), chatController.sendMessage);
chatRouter.post("/stream", validateBody(sendMessageSchema), chatController.streamMessage);
chatRouter.get("/", chatController.listConversations);
chatRouter.get("/trash", chatController.listTrash);
chatRouter.delete("/:conversationId/permanent", chatController.permanentlyDeleteConversation);
chatRouter.post("/:conversationId/restore", chatController.restoreConversation);
chatRouter.delete("/:conversationId", chatController.trashConversation);
chatRouter.get("/:conversationId", chatController.getConversation);
