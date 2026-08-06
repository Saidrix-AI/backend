import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The tutor is asked for explicitly, and the room is never destroyed.
 *
 * It used to ride room creation: automatic dispatch fires once, when a room is
 * *created*, so the service deleted an agentless room to force a fresh job.
 * That delete raced the student's own `roomJoin` grant, which silently
 * auto-creates the room whenever it is missing — and an auto-created room has
 * no metadata, so every agent dispatched into it read none and left again
 * ("no voice-session metadata — ignoring"). One client blip and the classroom
 * was mute for the rest of its life.
 *
 * So the rules these tests pin down: never delete the room, ask for a tutor
 * only when one is not already there, and put the session on the dispatch so it
 * does not depend on how the room came to exist.
 */
const calls: string[] = [];
const dispatches: { room: string; agent: string; metadata?: string }[] = [];
let participants: { identity: string }[] = [];

vi.mock("livekit-server-sdk", () => ({
  RoomServiceClient: class {
    async listRooms() {
      calls.push("listRooms");
      return [];
    }
    async listParticipants() {
      calls.push("listParticipants");
      return participants;
    }
    async deleteRoom() {
      calls.push("deleteRoom");
    }
    async createRoom() {
      calls.push("createRoom");
    }
  },
  AgentDispatchClient: class {
    async createDispatch(room: string, agent: string, options?: { metadata?: string }) {
      calls.push("createDispatch");
      dispatches.push({ room, agent, metadata: options?.metadata });
    }
  },
  AccessToken: class {
    addGrant() {}
    async toJwt() {
      return "test-token";
    }
  },
}));

// The ownership/active-course gate is stubbed here so these tests can stay
// about dispatch mechanics. That it is called at all is asserted below, and the
// gate's own behaviour is covered in lecture.test.ts / lecture-exam.test.ts.
const gateCalls: [string, string][] = [];
vi.mock("../src/services/lecture.service.js", () => ({
  assertLessonEnterable: async (userId: string, lessonId: string) => {
    gateCalls.push([userId, lessonId]);
  },
  getLectureByLessonId: async () => ({ language: "en" }),
}));

vi.mock("../src/database/models/enrollment.model.js", () => ({
  EnrollmentModel: {
    findOne: () => ({ select: () => ({ lean: async () => null }) }),
  },
}));

const { createVoiceSession } = await import("../src/services/voice.service.js");

const ROOM = "voice_507f1f77bcf86cd799439011_lesson-a";

const start = () =>
  createVoiceSession("507f1f77bcf86cd799439011", "s@example.com", {
    courseId: "",
    lessonId: "lesson-a",
  });

beforeEach(() => {
  calls.length = 0;
  gateCalls.length = 0;
  dispatches.length = 0;
  participants = [];
});

describe("voice room dispatch", () => {
  /**
   * The voice route used to mint a room for ANY lessonId with no ownership check
   * at all, which made it a way around both the lecture gate and the paywall:
   * the agent would then narrate another student's lecture to whoever asked.
   */
  it("refuses to mint a room before the lesson gate has run", async () => {
    await start();
    expect(gateCalls).toEqual([["507f1f77bcf86cd799439011", "lesson-a"]]);
  });

  it("creates the room and asks for a tutor on a first entry", async () => {
    await start();
    expect(calls).toEqual(["createRoom", "listParticipants", "createDispatch"]);
  });

  it("asks for a tutor again when the room was left without one", async () => {
    participants = [{ identity: "507f1f77bcf86cd799439011" }];

    await start();
    expect(calls).toContain("createDispatch");
  });

  it("leaves a room that already has its tutor alone", async () => {
    participants = [{ identity: "507f1f77bcf86cd799439011" }, { identity: "agent-AJ_abc123" }];

    await start();
    expect(calls).not.toContain("createDispatch");
  });

  /**
   * The delete is the whole bug: it raced the client's own room auto-create and
   * left behind a metadata-less room no agent would work in.
   */
  it("never deletes the room, in any state", async () => {
    for (const state of [[], [{ identity: "507f1f77bcf86cd799439011" }]]) {
      participants = state;
      await start();
    }
    expect(calls).not.toContain("deleteRoom");
  });

  /**
   * This is what makes an auto-created (metadata-less) room survivable: the
   * agent reads the session off its job, not off the room.
   */
  it("carries the session on the dispatch, not just on the room", async () => {
    await start();
    expect(dispatches).toHaveLength(1);
    expect(dispatches[0]!.room).toBe(ROOM);
    expect(dispatches[0]!.agent).toBe("saidrix-tutor");
    expect(JSON.parse(dispatches[0]!.metadata!)).toEqual({
      userId: "507f1f77bcf86cd799439011",
      courseId: "",
      lessonId: "lesson-a",
      language: "en",
      completed: false,
    });
  });

  it("still mints a joinable session", async () => {
    const session = await start();
    expect(session.roomName).toBe(ROOM);
    expect(session.token).toBe("test-token");
  });
});
