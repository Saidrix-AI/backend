import { describe, expect, it } from "vitest";
import { renderEmail } from "../src/utils/emailTemplate.js";
import { otpEmail, passwordResetEmail } from "../src/utils/mailer.js";

describe("email template", () => {
  it("renders a self-contained document with no remote assets", () => {
    const html = renderEmail({
      preheader: "Preview line",
      heading: "Heading",
      paragraphs: ["Body copy."],
    });
    expect(html.startsWith("<!doctype html>")).toBe(true);
    // Blocked remote images and stripped <style> blocks are the two things that
    // break a transactional email in a real inbox; neither may creep back in.
    expect(html).not.toMatch(/<img/i);
    expect(html).not.toMatch(/<style/i);
    expect(html).not.toMatch(/https?:\/\/(?!www\.w3\.org)/);
    expect(html).toContain("Preview line");
    expect(html).toContain("Body copy.");
  });

  it("escapes caller-supplied text", () => {
    const html = renderEmail({
      preheader: "p",
      heading: "Hi <script>alert(1)</script>",
      paragraphs: ['Tom & "Jerry"'],
    });
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("Tom &amp; &quot;Jerry&quot;");
  });

  it("leaves no empty slots when a block is omitted", () => {
    const html = renderEmail({ preheader: "p", heading: "h", paragraphs: ["one"] });
    expect(html).not.toContain("undefined");
    expect(html).not.toContain("[object Object]");
  });
});

describe("transactional emails", () => {
  it("puts the OTP in the subject, the body and the plain-text part", () => {
    const mail = otpEmail("123456");
    // The subject leads with the code so a phone's notification preview alone
    // is enough to type it.
    expect(mail.subject.startsWith("123456")).toBe(true);
    expect(mail.text).toContain("123456");
    expect(mail.html).toContain("123456");
    expect(mail.html).toContain("expires in 10 minutes");
  });

  it("gives the reset link as a button and as pasteable text", () => {
    const link = "https://saidrix.app/reset-password?token=abc123&from=email";
    const mail = passwordResetEmail(link);
    expect(mail.text).toContain(link);
    // Once as the button's href, then again as href + visible text in the
    // "paste this" fallback, for clients that strip the button.
    const occurrences = mail.html!.split("saidrix.app/reset-password").length - 1;
    expect(occurrences).toBeGreaterThanOrEqual(3);
    // A raw & in an href is invalid HTML and some clients truncate the link there.
    expect(mail.html).toContain("token=abc123&amp;from=email");
    expect(mail.html).not.toContain("token=abc123&from=email");
    expect(mail.html).toContain("expires in 30 minutes");
  });
});
