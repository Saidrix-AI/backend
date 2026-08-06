import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * LiveKit auto-dispatch fires once, when a room is *created*. `createRoom` is
 * idempotent, so a room that exists with no agent in it — what a dropped job
 * request leaves behind — can never get a tutor: every re-entry reuses the same
 * agentless room until it times out, and the student sits in a silent class.
 *
 * So the rule these tests pin down: rebuild the room when, and only when, it
 * exists without an agent.
 */
const calls: string[] = [];
let rooms: { name: string }[] = [];
let participants: { identity: string }[] = [];

vi.mock("livekit-server-sdk", () => ({
  RoomServiceClient: class {
    async listRooms() {
      calls.push("listRooms");
      return rooms;
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

const start = () =>
  createVoiceSession("507f1f77bcf86cd799439011", "s@example.com", {
    courseId: "",
    lessonId: "lesson-a",
  });

beforeEach(() => {
  calls.length = 0;
  gateCalls.length = 0;
  rooms = [];
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

  it("creates the room on a first entry, with nothing to clean up", async () => {
    await start();
    expect(calls).toEqual(["listRooms", "createRoom"]);
  });

  it("rebuilds a room left without an agent, so dispatch fires again", async () => {
    rooms = [{ name: "voice_507f1f77bcf86cd799439011_lesson-a" }];
    participants = [{ identity: "507f1f77bcf86cd799439011" }];

    await start();
    expect(calls).toEqual(["listRooms", "listParticipants", "deleteRoom", "createRoom"]);
  });

  it("leaves a room that already has its tutor alone", async () => {
    rooms = [{ name: "voice_507f1f77bcf86cd799439011_lesson-a" }];
    participants = [{ identity: "507f1f77bcf86cd799439011" }, { identity: "agent-AJ_abc123" }];

    await start();
    expect(calls).not.toContain("deleteRoom");
    expect(calls).toEqual(["listRooms", "listParticipants", "createRoom"]);
  });

  it("rebuilds an empty lingering room", async () => {
    rooms = [{ name: "voice_507f1f77bcf86cd799439011_lesson-a" }];
    participants = [];

    await start();
    expect(calls).toContain("deleteRoom");
  });

  it("still mints a joinable session", async () => {
    const session = await start();
    expect(session.roomName).toBe("voice_507f1f77bcf86cd799439011_lesson-a");
    expect(session.token).toBe("test-token");
  });
});
