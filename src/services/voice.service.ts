import { AccessToken, AgentDispatchClient, RoomServiceClient } from "livekit-server-sdk";
import { env } from "../config/env.js";
import { assertLessonEnterable, getLectureByLessonId } from "./lecture.service.js";
import { EnrollmentModel } from "../database/models/enrollment.model.js";
import { ApiError } from "../utils/apiError.js";
import { logger } from "../utils/logger.js";

// LiveKit's server API is HTTP(S) even when clients connect over ws(s).
const livekitHost = env.LIVEKIT_URL.replace(/^ws/, "http");
const roomService = new RoomServiceClient(livekitHost, env.LIVEKIT_API_KEY, env.LIVEKIT_API_SECRET);
const dispatchService = new AgentDispatchClient(
  livekitHost,
  env.LIVEKIT_API_KEY,
  env.LIVEKIT_API_SECRET,
);

export interface VoiceSessionInput {
  courseId: string;
  lessonId: string;
}

/**
 * The worker registers under this name (voice-service/app/worker.py), which
 * turns LiveKit's automatic dispatch OFF for it: jobs come only from the
 * explicit dispatches created below.
 */
const AGENT_NAME = "saidrix-tutor";

/** LiveKit names every agent participant `agent-<jobId>`; students join as their user id. */
function isAgent(identity: string): boolean {
  return identity.startsWith("agent-");
}

/**
 * Asks for a tutor unless one is already in the room.
 *
 * This replaces a delete-and-recreate hack. Automatic dispatch fires only when
 * a room is *created*, so the only way to re-request a tutor used to be to
 * delete the room — which raced the student's own `roomJoin` grant, because
 * that silently auto-creates the room whenever it is missing. The loser of that
 * race was a room with no metadata, and every agent dispatched into one read no
 * metadata and left again: a classroom that never spoke, for the rest of its
 * life. Explicit dispatch asks directly and destroys nothing, so a reconnect
 * lands back on the live session instead of demolishing it.
 *
 * The metadata travels on the *job*, which is what makes it independent of how
 * the room came to exist.
 */
async function ensureTutorDispatched(roomName: string, session: string): Promise<void> {
  const participants = await roomService.listParticipants(roomName).catch(() => []);
  if (participants.some((p) => isAgent(p.identity))) return;

  await dispatchService.createDispatch(roomName, AGENT_NAME, { metadata: session });
}

/**
 * Refuses a new class once the speech provider's concurrency is spoken for.
 *
 * Cartesia bills a plan's worth of SIMULTANEOUS requests, not a monthly pool,
 * so the limit is on classes in progress. Past it, Cartesia rejects the
 * synthesis — which surfaces as a tutor that joins the room and then says
 * nothing, the single worst failure this product has, because it looks like a
 * bug in the class rather than a queue.
 *
 * Counted from live rooms rather than from a counter we keep, because the truth
 * is LiveKit's: a crashed worker or a browser that never disconnected would
 * leave our own number drifting up until nobody could start a class at all.
 *
 * Reconnecting into a room that already exists is always allowed — the student
 * is already counted, and turning a dropped connection into a refusal would
 * punish exactly the person the limit is not about.
 *
 * Fails OPEN. If LiveKit cannot be listed we do not know the number, and
 * guessing "too many" would close the product over a monitoring blip.
 */
async function assertCapacity(roomName: string): Promise<void> {
  const limit = env.VOICE_MAX_CONCURRENT_SESSIONS;
  if (limit <= 0) return;

  let rooms;
  try {
    rooms = await roomService.listRooms();
  } catch (err) {
    logger.warn({ err }, "could not count live classes — allowing this one");
    return;
  }

  const live = rooms.filter((r) => r.name.startsWith("voice_"));
  if (live.some((r) => r.name === roomName)) return;
  if (live.length < limit) return;

  logger.warn({ live: live.length, limit }, "voice concurrency reached — refusing a new class");
  throw new ApiError(
    429,
    "All the tutor's lines are busy right now. The lesson is open to read, and voice will " +
      "come back in a few minutes — try again then.",
  );
}

/**
 * Creates (or reuses) the deterministic per-user-per-lesson LiveKit room and
 * mints a participant token for the student. Room metadata carries everything
 * the voice agent needs to run the session; the deterministic name means a
 * reconnect lands back in the same room and resumes from Redis state.
 */
export async function createVoiceSession(
  userId: string,
  email: string,
  { courseId, lessonId }: VoiceSessionInput,
) {
  // The active-course rule, and the ownership check behind it. Without this the
  // voice route was a way around every gate the HTTP lecture routes enforce:
  // any lessonId minted a room, and the agent then narrated whoever's lecture
  // that was to whoever asked.
  await assertLessonEnterable(userId, lessonId);

  // 404s if the lecture doesn't exist — no point minting a room for nothing.
  const lecture = await getLectureByLessonId(userId, lessonId);

  // Already-completed lessons open in review mode (agent greets, no auto-narrate).
  let completed = false;
  if (courseId) {
    const enrollment = await EnrollmentModel.findOne({ userId, courseId })
      .select("completedLessonIds")
      .lean();
    completed = enrollment?.completedLessonIds?.includes(lessonId) ?? false;
  }

  const roomName = `voice_${userId}_${lessonId}`;
  await assertCapacity(roomName);
  const session = JSON.stringify({
    userId,
    courseId,
    lessonId,
    language: lecture.language,
    completed,
  });
  await roomService.createRoom({
    name: roomName,
    emptyTimeout: 300,
    departureTimeout: 60,
    maxParticipants: 5,
    metadata: session,
  });
  await ensureTutorDispatched(roomName, session);

  const at = new AccessToken(env.LIVEKIT_API_KEY, env.LIVEKIT_API_SECRET, {
    identity: userId,
    name: email,
    ttl: "2h",
  });
  at.addGrant({
    roomJoin: true,
    room: roomName,
    canPublish: true,
    canSubscribe: true,
    canPublishData: true,
  });

  return {
    url: env.LIVEKIT_URL,
    token: await at.toJwt(),
    roomName,
    language: lecture.language,
  };
}
