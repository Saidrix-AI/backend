import { Router } from "express";
import { z } from "zod";
import * as userController from "../controller/user.controller.js";
import { requireAuth } from "../middleware/auth.middleware.js";
import { validateBody } from "../middleware/validate.middleware.js";
import {
  AGE_BANDS,
  EDUCATION_LEVELS,
  OCCUPATIONS,
  OPERATING_SYSTEMS,
  SELF_RATED_LEVELS,
  YEAR_MAX,
  YEAR_MIN,
} from "../database/models/learnerProfile.model.js";
import { PREFERRED_LANGUAGES } from "../database/models/user.model.js";

// All fields optional (partial update). email / username / role are NOT here —
// zod strips unknown keys, so they can never be changed via this endpoint.
//
// The second group is the learner profile (see services/learnerProfile.service).
// Editing any of these here stamps its source as "profile", which permanently
// locks it against the passive chat extractor. Empty strings are allowed and DO
// clear the field — this is the one path where the student is deliberately
// erasing an answer rather than declining to give one.
const profileUpdateSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  phone: z.string().max(30).optional(),
  dateOfBirth: z
    .string()
    .refine((v) => !Number.isNaN(Date.parse(v)), "Invalid date")
    .nullable()
    .optional(),
  country: z.string().max(60).optional(),
  address: z.string().max(200).optional(),
  timezone: z.string().max(60).optional(),
  language: z.string().max(40).optional(),
  // Recorded, never applied — see the User model. An empty array is the valid
  // "no preference" answer, so there is no sentinel value in the enum.
  preferredLanguages: z.array(z.enum(PREFERRED_LANGUAGES)).max(5).optional(),
  referralSource: z.string().max(60).optional(),
  bio: z.string().max(500).optional(),

  ageBand: z.enum([...AGE_BANDS, ""]).optional(),
  occupation: z.enum([...OCCUPATIONS, ""]).optional(),
  operatingSystem: z.enum([...OPERATING_SYSTEMS, ""]).optional(),
  educationLevel: z.enum([...EDUCATION_LEVELS, ""]).optional(),
  educationDetail: z.string().max(80).optional(),
  institutionName: z.string().max(120).optional(),
  fieldOfStudy: z.string().max(80).optional(),
  studyStartYear: z.coerce.number().int().min(YEAR_MIN).max(YEAR_MAX).nullable().optional(),
  studyEndYear: z.coerce.number().int().min(YEAR_MIN).max(YEAR_MAX).nullable().optional(),
  companyName: z.string().max(120).optional(),
  industry: z.string().max(80).optional(),
  roleTitle: z.string().max(80).optional(),
  experienceYears: z.coerce.number().int().min(0).max(60).nullable().optional(),
  roleSummary: z.string().max(300).optional(),
  learningInterests: z.array(z.string().max(60)).max(8).optional(),
  careerGoal: z.string().max(200).optional(),
  weeklyHours: z.coerce.number().int().min(0).max(80).nullable().optional(),
  preferredStyle: z.string().max(200).optional(),
  biggestBlocker: z.string().max(200).optional(),
  selfRatedLevel: z.enum([...SELF_RATED_LEVELS, ""]).optional(),
});

// The Finish-profile flow's own state. The answers do NOT come through here —
// they go to PATCH /profile like any other profile edit.
const profileSetupSchema = z.object({
  step: z.coerce.number().int().min(0).max(1).optional(),
  status: z.enum(["completed", "skipped"]).optional(),
});

// Base64 data URL. ~900K chars ≈ ~650KB image — client resizes before upload.
const avatarSchema = z.object({
  avatar: z
    .string()
    .max(900_000, "Image is too large")
    .refine((v) => v === "" || v.startsWith("data:image/"), "Must be an image data URL"),
});

// There is deliberately no route for setting `plan` here.
//
// There used to be — `PUT /plan` took a tier name from the browser and saved
// it, which meant any logged-in account could award itself Premium for free.
// A plan is now written in exactly one place, from a signature-verified
// LemonSqueezy webhook: services/subscription.service.ts#applySubscriptionState.
// Buying one goes through POST /api/billing/checkout.

export const userRouter = Router();

userRouter.use(requireAuth);
userRouter.get("/profile", userController.getProfile);
userRouter.patch("/profile", validateBody(profileUpdateSchema), userController.updateProfile);
userRouter.patch(
  "/profile-setup",
  validateBody(profileSetupSchema),
  userController.updateProfileSetup,
);
userRouter.put("/avatar", validateBody(avatarSchema), userController.updateAvatar);
userRouter.get("/stats", userController.stats);
userRouter.put("/wishlist/:courseId", userController.toggleWishlist);
