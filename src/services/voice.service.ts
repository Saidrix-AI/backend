import { AccessToken, RoomServiceClient } from "livekit-server-sdk";
import { env } from "../config/env.js";
import { assertLessonEnterable, getLectureByLessonId } from "./lecture.service.js";
import { EnrollmentModel } from "../database/models/enrollment.model.js";

// LiveKit's server API is HTTP(S) even when clients connect over ws(s).
const livekitHost = env.LIVEKIT_URL.replace(/^ws/, "http");
const roomService = new RoomServiceClient(livekitHost, env.LIVEKIT_API_KEY, env.LIVEKIT_API_SECRET);

export interface VoiceSessionInput {
  courseId: string;
  lessonId: string;
}

/** LiveKit names every agent participant `agent-<jobId>`; students join as their user id. */
function isAgent(identity: string): boolean {
  return identity.startsWith("agent-");
}

/**
 * Makes sure the room the student is about to join will actually get a tutor.
 *
 * LiveKit auto-dispatch only fires when a room is *created*. `createRoom` is
 * idempotent, so a room that exists but has no agent in it — which is what a
 * dropped dispatch leaves behind ("failed to send job request: no servers
 * available") — can never recover on its own: every re-entry reuses the same
 * agentless room until it times out, and the student sits in a silent
 * classroom. Deleting it first turns the next createRoom into a real creation,
 * and therefore a fresh dispatch.
 *
 * A room that already has its agent is left alone, so reconnecting (or a second
 * tab) still lands on the live session instead of killing it.
 */
async function ensureDispatchableRoom(roomName: string): Promise<void> {
  const [existing] = await roomService.listRooms([roomName]).catch(() => []);
  if (!existing) return;

  const participants = await roomService.listParticipants(roomName).catch(() => []);
  if (participants.some((p) => isAgent(p.identity))) return;

  await roomService.deleteRoom(roomName).catch(() => {
    /* already gone — createRoom below will make a fresh one anyway */
  });
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
  await ensureDispatchableRoom(roomName);
  await roomService.createRoom({
    name: roomName,
    emptyTimeout: 300,
    departureTimeout: 60,
    maxParticipants: 5,
    metadata: JSON.stringify({ userId, courseId, lessonId, language: lecture.language, completed }),
  });

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
