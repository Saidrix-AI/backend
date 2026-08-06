import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Hoisted so the vi.mock factory (which runs before the imports above) can see them.
const smtp = vi.hoisted(() => ({
  createTransport: vi.fn(),
  send: vi.fn(),
}));

vi.mock("nodemailer", () => ({
  default: { createTransport: smtp.createTransport },
}));

// SMTP fully configured, so a passing test proves NODE_ENV is what stops the
// send — not a missing host. Set before the first import of config/env.js:
// dotenv does not override keys already present in process.env.
const SMTP_ENV = {
  SMTP_HOST: "smtp.example.test",
  SMTP_PORT: "587",
  SMTP_USER: "user",
  SMTP_PASS: "pass",
};

const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const [key, value] of Object.entries(SMTP_ENV)) {
    savedEnv[key] = process.env[key];
    process.env[key] = value;
  }
  savedEnv.NODE_ENV = process.env.NODE_ENV;
  smtp.createTransport.mockReturnValue({ sendMail: smtp.send });
  smtp.send.mockResolvedValue({ messageId: "mocked" });
});

afterEach(() => {
  for (const key of Object.keys(savedEnv)) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  vi.clearAllMocks();
  vi.resetModules();
});

describe("mailer transport", () => {
  it("never opens SMTP under NODE_ENV=test, even with SMTP configured", async () => {
    expect(process.env.NODE_ENV).toBe("test");

    const { sendMail, otpEmail } = await import("../src/utils/mailer.js");
    // The exact call every registering test makes, ~20 files over.
    await sendMail({ to: "student@example.com", ...otpEmail("123456") });

    expect(smtp.createTransport).not.toHaveBeenCalled();
    expect(smtp.send).not.toHaveBeenCalled();
  });

  it("still sends through SMTP outside tests", async () => {
    // Pins the guard to NODE_ENV specifically, and proves the assertion above
    // is not just a broken mock that could never register a call.
    process.env.NODE_ENV = "development";
    vi.resetModules();

    const { sendMail } = await import("../src/utils/mailer.js");
    await sendMail({ to: "student@example.com", subject: "s", text: "t" });

    expect(smtp.createTransport).toHaveBeenCalledOnce();
    expect(smtp.send).toHaveBeenCalledOnce();
    expect(smtp.send.mock.calls[0][0]).toMatchObject({ to: "student@example.com" });
  });
});
