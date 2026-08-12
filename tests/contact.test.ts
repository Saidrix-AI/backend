import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose from "mongoose";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `POST /api/contact` — the only endpoint that sends mail without an account.
 *
 * That makes it the most abusable surface in the API: if any of the recipient,
 * the `from`, or the header handling is wrong, it becomes a spam relay that
 * sends from our own domain and burns the sending reputation that signup and
 * password-reset mail depends on. Most of what is asserted here is that.
 */
const sendMail = vi.fn(async () => undefined);
vi.mock("../src/utils/mailer.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/utils/mailer.js")>();
  return { ...actual, sendMail: (...args: unknown[]) => sendMail(...(args as [])) };
});

const { app } = await import("../src/app.js");
const { env } = await import("../src/config/env.js");
const { UserModel } = await import("../src/database/models/user.model.js");
const { signAccessToken } = await import("../src/services/token.service.js");

let mongo: MongoMemoryServer;

const VALID = {
  name: "Ada Lovelace",
  email: "ada@example.com",
  subject: "Team plans",
  message: "Could you tell me about pricing for a team of twelve people?",
  category: "billing",
};

/** The single argument `sendMail` was called with. */
function mailed(): {
  to: string;
  subject: string;
  text: string;
  html?: string;
  replyTo?: { name: string; address: string };
} {
  // The mock is declared with no parameters, so vitest types its recorded calls
  // as an empty tuple.
  const args = sendMail.mock.calls[0] as unknown as [Record<string, unknown>];
  return args[0] as never;
}

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongo.stop();
});

beforeEach(async () => {
  sendMail.mockClear();
  await UserModel.deleteMany({});
});

describe("contact: delivery", () => {
  it("sends to the configured inbox, from us, replying to the visitor", async () => {
    const res = await request(app).post("/api/contact").send(VALID);
    expect(res.status).toBe(200);

    const mail = mailed();
    expect(mail.to).toBe(env.CONTACT_INBOX);
    // `from` is never set here — sendMail applies MAIL_FROM itself, which is
    // the domain we are actually authorised to send as.
    expect(mail).not.toHaveProperty("from");
    expect(mail.replyTo?.address).toBe("ada@example.com");
    expect(mail.text).toContain("Could you tell me about pricing");
  });

  it("works with no session at all", async () => {
    // The landing page's form has no token. If this ever required auth the
    // public form would silently 401.
    const res = await request(app).post("/api/contact").send(VALID);
    expect(res.status).toBe(200);
    expect(mailed().text).toContain("UNVERIFIED");
  });

  it("identifies a signed-in sender from the session, not the body", async () => {
    const user = await UserModel.create({
      name: "Real Person",
      username: "realperson",
      email: "real@example.com",
      passwordHash: "x",
      emailVerified: true,
    });
    const token = signAccessToken(String(user._id), user.email);

    const res = await request(app)
      .post("/api/contact")
      .set("Authorization", `Bearer ${token}`)
      .send({ ...VALID, name: "Someone Else", email: "attacker@evil.example" });

    expect(res.status).toBe(200);
    const mail = mailed();
    // The posted name and address are ignored in favour of the account's.
    expect(mail.replyTo?.address).toBe("real@example.com");
    expect(JSON.stringify(mail)).not.toContain("attacker@evil.example");
    expect(mail.text).toContain("@realperson");
  });
});

describe("contact: abuse guards", () => {
  it("ignores a recipient supplied in the body", async () => {
    // The open-relay test. Nothing in the request may redirect where mail goes.
    const res = await request(app)
      .post("/api/contact")
      .send({ ...VALID, to: "victim@example.com", cc: "victim2@example.com" });

    expect(res.status).toBe(200);
    const mail = mailed();
    expect(mail.to).toBe(env.CONTACT_INBOX);
    expect(JSON.stringify(mail)).not.toContain("victim@example.com");
    expect(JSON.stringify(mail)).not.toContain("victim2@example.com");
  });

  it("strips CR/LF so a name cannot inject a header", async () => {
    // `x\r\nBcc: victim@…` is how a naive implementation grows recipients.
    const res = await request(app)
      .post("/api/contact")
      .send({
        ...VALID,
        name: "Ada\r\nBcc: victim@example.com",
        subject: "Hello\nX-Injected: yes",
      });

    expect(res.status).toBe(200);
    const mail = mailed();

    // The property that matters: no newline reaches a header, and the address
    // is exactly the one field it is allowed to be — the smuggled recipient
    // never becomes an address, whatever it did to the display name.
    expect(mail.replyTo?.address).toBe("ada@example.com");
    expect(mail.replyTo?.name).not.toMatch(/[\r\n]/);
    expect(mail.replyTo?.address).not.toMatch(/[\r\n]/);
    // The subject keeps the literal text "X-Injected: yes" and that is fine —
    // a colon is legal inside a Subject value. What made it an injection was
    // the newline, and that is what has to be gone.
    expect(mail.subject).not.toMatch(/[\r\n]/);

    // And the display name carries nothing that is structurally meaningful in
    // an address list, so it cannot be re-tokenized into one.
    expect(mail.replyTo?.name).not.toMatch(/[<>,;:"\\]/);
  });

  it("rejects a malformed or oversized body", async () => {
    const cases = [
      { ...VALID, email: "not-an-email" },
      { ...VALID, message: "too short" },
      { ...VALID, name: "" },
      { ...VALID, message: "x".repeat(2001) },
      { ...VALID, subject: "y".repeat(151) },
    ];

    for (const body of cases) {
      const res = await request(app).post("/api/contact").send(body);
      expect(res.status, JSON.stringify(body).slice(0, 60)).toBe(400);
    }
    expect(sendMail).not.toHaveBeenCalled();
  });

  it("rejects a category that is not one of ours", async () => {
    const res = await request(app)
      .post("/api/contact")
      .send({ ...VALID, category: "'; DROP TABLE" });
    expect(res.status).toBe(400);
    expect(sendMail).not.toHaveBeenCalled();
  });

  it("escapes the message in the HTML body", async () => {
    await request(app)
      .post("/api/contact")
      .send({ ...VALID, message: "<script>alert(1)</script> and more text here" });

    const html = mailed().html ?? "";
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });
});
