import bcrypt from "bcryptjs";
import { Types, type HydratedDocument } from "mongoose";
import type { PlanId } from "../config/plans.js";
import { UserModel, type User } from "../database/models/user.model.js";
import { ApiError } from "../utils/apiError.js";
import { isTrialAvailableFor, sessionStatus, type PlanStatus } from "./subscription.service.js";
import { issueRefreshToken, signAccessToken } from "./token.service.js";

const BCRYPT_ROUNDS = 12;
/** How many failed logins one account is worth. Exported so the suite asserts the real cap. */
export const MAX_FAILED_ATTEMPTS = 5;
const LOCK_MINUTES = 15;

// ---------------------------------------------------------------------------
// Username rules
//
// These live here rather than in the route schema so the realtime availability
// check, the register schema and the DB write all read from one definition. A
// realtime "available ✓" that submit then rejects is worse than no check at
// all, so the two must never be able to drift apart.
export const USERNAME_MIN_LENGTH = 3;
export const USERNAME_MAX_LENGTH = 30;
export const USERNAME_PATTERN = /^[a-zA-Z0-9_.]+$/;
export const USERNAME_PATTERN_MESSAGE = "Username may only contain letters, numbers, _ and .";
export const USERNAME_TAKEN_MESSAGE = "That username is already taken — try another one.";
const DUPLICATE_ACCOUNT_MESSAGE = "An account with this email or username already exists";

/** Usernames are stored lowercase, so `Riaz` and `riaz` are the same account. */
export function normalizeUsername(raw: string): string {
  return raw.trim().toLowerCase();
}

export type UsernameCheck = { username: string; available: boolean; reason?: string };

/** Format-only check — no DB round trip. Mirrors registerSchema exactly. */
export function checkUsernameFormat(raw: string): UsernameCheck {
  const username = normalizeUsername(raw);
  if (!username) return { username, available: false, reason: "Pick a username" };
  if (username.length < USERNAME_MIN_LENGTH) {
    return { username, available: false, reason: `At least ${USERNAME_MIN_LENGTH} characters` };
  }
  if (username.length > USERNAME_MAX_LENGTH) {
    return { username, available: false, reason: `At most ${USERNAME_MAX_LENGTH} characters` };
  }
  if (!USERNAME_PATTERN.test(username)) {
    return { username, available: false, reason: USERNAME_PATTERN_MESSAGE };
  }
  return { username, available: true };
}

/** Format check plus a uniqueness lookup, for the signup form's live check. */
export async function checkUsernameAvailability(raw: string): Promise<UsernameCheck> {
  const format = checkUsernameFormat(raw);
  if (!format.available) return format;

  const taken = await UserModel.exists({ username: format.username });
  return taken
    ? { username: format.username, available: false, reason: USERNAME_TAKEN_MESSAGE }
    : format;
}

/** The field a Mongo duplicate-key (E11000) error collided on, else null. */
function duplicateKeyField(err: unknown): string | null {
  const e = err as { code?: number; keyPattern?: Record<string, unknown> };
  if (e?.code !== 11000) return null;
  return Object.keys(e.keyPattern ?? {})[0] ?? "unknown";
}

// A real hash to compare against when the account is missing, so login timing
// does not reveal whether an email/username exists (enumeration defense).
const DUMMY_HASH = bcrypt.hashSync("timing-safe-dummy-password", BCRYPT_ROUNDS);

export interface PublicUser {
  id: string;
  name: string;
  username: string;
  email: string;
  emailVerified: boolean;
  /**
   * The subscription mirror, carried on the session payload so the client can
   * decide whether to render the app or the pricing page on first paint,
   * without a second round trip. It is a hint for routing only — every gated
   * endpoint re-checks server-side (middleware/subscription.middleware.ts).
   */
  plan: PlanId | null;
  planStatus: PlanStatus;
  /**
   * When the running free trial ends, or null. Drives the countdown banner —
   * the student handed over a card and will be charged, so saying so plainly
   * is an obligation, not a nicety.
   */
  trialEndsAt: string | null;
  /** Whether to offer a trial on the plan cards. The server re-decides at checkout. */
  trialEligible: boolean;
}

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
  user: PublicUser;
}

function toPublicUser(user: HydratedDocument<User>): PublicUser {
  return {
    id: user._id.toString(),
    name: user.name,
    username: user.username,
    email: user.email,
    emailVerified: user.emailVerified,
    plan: (user.plan ?? null) as PlanId | null,
    // What the paywall would actually enforce, not the raw stored value: a
    // grace period that ran out reads as lapsed even before the expiry webhook
    // lands, and a deployment with billing switched off reads as open.
    planStatus: sessionStatus(user),
    trialEndsAt: user.trialEndsAt?.toISOString() ?? null,
    trialEligible: isTrialAvailableFor(user),
  };
}

async function issueTokens(
  user: HydratedDocument<User>,
  meta: { userAgent?: string; ip?: string },
): Promise<AuthTokens> {
  const userId = user._id.toString();
  const accessToken = signAccessToken(userId, user.email);
  const refreshToken = await issueRefreshToken(userId, meta);
  return { accessToken, refreshToken, user: toPublicUser(user) };
}

export async function register(
  input: { name: string; username: string; email: string; password: string },
  meta: { userAgent?: string; ip?: string } = {},
): Promise<AuthTokens> {
  const email = input.email.trim().toLowerCase();
  const username = normalizeUsername(input.username);

  const [usernameTaken, emailTaken] = await Promise.all([
    UserModel.exists({ username }),
    UserModel.exists({ email }),
  ]);
  // A username collision is named outright: availability is already public via
  // /check-username, so hiding it here would only leave the student guessing
  // which of the two fields to change. Email stays generic — that one really
  // would be an account-enumeration oracle.
  if (usernameTaken) throw new ApiError(409, USERNAME_TAKEN_MESSAGE);
  if (emailTaken) throw new ApiError(409, DUPLICATE_ACCOUNT_MESSAGE);

  const passwordHash = await bcrypt.hash(input.password, BCRYPT_ROUNDS);

  let user: HydratedDocument<User>;
  try {
    user = await UserModel.create({ name: input.name, username, email, passwordHash });
  } catch (err) {
    // Two signups racing for the same name both clear the check above — the
    // unique index is the only thing that actually stops the duplicate. Turn
    // its E11000 into the same clean 409 rather than letting it read as a 500.
    const field = duplicateKeyField(err);
    if (!field) throw err;
    throw new ApiError(409, field === "username" ? USERNAME_TAKEN_MESSAGE : DUPLICATE_ACCOUNT_MESSAGE);
  }

  return issueTokens(user, meta);
}

export async function login(
  identifier: string,
  password: string,
  meta: { userAgent?: string; ip?: string } = {},
): Promise<AuthTokens> {
  const id = identifier.toLowerCase();
  const user = await UserModel.findOne({ $or: [{ email: id }, { username: id }] });

  // Lockout check first — but still run a compare below to keep timing uniform.
  const locked = user?.lockedUntil && user.lockedUntil.getTime() > Date.now();

  const matches = await bcrypt.compare(password, user?.passwordHash ?? DUMMY_HASH);

  if (!user || !matches) {
    if (user) {
      // Atomic $inc — read-then-write here would let concurrent guesses share
      // one increment (lost-update race), turning MAX_FAILED_ATTEMPTS into a
      // formality. Same fix as the OTP attempt counter in verification.service.ts.
      const updated = await UserModel.findOneAndUpdate(
        { _id: user._id },
        { $inc: { failedLoginAttempts: 1 } },
        { new: true },
      );
      if (updated && updated.failedLoginAttempts >= MAX_FAILED_ATTEMPTS) {
        await UserModel.updateOne(
          { _id: user._id },
          { $set: { lockedUntil: new Date(Date.now() + LOCK_MINUTES * 60 * 1000), failedLoginAttempts: 0 } },
        );
      }
    } else {
      // No account: perform an equivalent-cost no-op write so response timing
      // doesn't reveal whether the identifier exists (enumeration defense).
      await UserModel.updateOne({ _id: new Types.ObjectId() }, { $set: { lockedUntil: null } });
    }
    throw new ApiError(401, "Invalid credentials");
  }

  if (locked) {
    throw new ApiError(423, "Account temporarily locked due to too many failed attempts. Try again later.");
  }

  if (user.failedLoginAttempts > 0 || user.lockedUntil) {
    user.failedLoginAttempts = 0;
    user.lockedUntil = undefined;
    await user.save();
  }

  return issueTokens(user, meta);
}

export async function getUserById(userId: string): Promise<PublicUser> {
  const user = await UserModel.findById(userId);
  if (!user) throw new ApiError(404, "User not found");
  return toPublicUser(user);
}
