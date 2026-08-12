import nodemailer, { type Transporter } from "nodemailer";
import { env } from "../config/env.js";
import { renderEmail } from "./emailTemplate.js";
import { logger } from "./logger.js";

let transporter: Transporter | null = null;

/**
 * Returns a nodemailer transport when SMTP is configured, otherwise null.
 * Without SMTP we fall back to logging the email (dev-friendly, non-blocking).
 *
 * Never returns a transport under NODE_ENV=test: ~20 test files register users,
 * and every registration sends an OTP, so a configured .env made the suite mail
 * real messages to example.com addresses. Those bounces cost the sending domain
 * the Brevo reputation that real signup and reset mail depends on. Mirrors
 * rateLimit.middleware.ts, which disables itself the same way.
 */
function getTransporter(): Transporter | null {
  if (process.env.NODE_ENV === "test") return null;
  if (transporter) return transporter;
  if (!env.SMTP_HOST || !env.SMTP_PORT) return null;

  transporter = nodemailer.createTransport({
    host: env.SMTP_HOST,
    port: env.SMTP_PORT,
    secure: env.SMTP_SECURE,
    auth:
      env.SMTP_USER && env.SMTP_PASS
        ? { user: env.SMTP_USER, pass: env.SMTP_PASS }
        : undefined,
  });
  return transporter;
}

export interface MailInput {
  to: string;
  subject: string;
  text: string;
  html?: string;
  /**
   * Where a reply should go, when that is not the sender.
   *
   * The contact forms need this: the mail is sent BY us to our own inbox, but
   * answering it has to reach the visitor. Their address belongs here and never
   * in `from` — `from` stays `MAIL_FROM`, which is the domain we are authorised
   * to send as.
   *
   * Prefer the `{ name, address }` form for anything built from user input.
   * Nodemailer then does the quoting and encoding, so a display name cannot
   * change how the header parses — which hand-concatenating `Name <addr>`
   * quietly relies on the name being well-behaved.
   */
  replyTo?: string | { name: string; address: string };
}

/**
 * Sends an email via SMTP if configured; otherwise logs it (dev fallback) so
 * OTPs and reset links are still visible during local development.
 */
export async function sendMail({ to, subject, text, html, replyTo }: MailInput): Promise<void> {
  const tx = getTransporter();
  if (!tx) {
    logger.info(
      { to, subject, text, replyTo },
      "[mailer:dev] no SMTP transport (unconfigured, or NODE_ENV=test) — email logged, not sent",
    );
    return;
  }

  await tx.sendMail({ from: env.MAIL_FROM, to, subject, text, html, replyTo });
  logger.info({ to, subject }, "Email sent");
}

export function otpEmail(code: string): Omit<MailInput, "to"> {
  return {
    subject: `${code} is your Saidrix verification code`,
    // Leading with the code lets a phone's notification preview carry it, so
    // the student can type it without opening the mail at all.
    text: [
      `Your Saidrix verification code is ${code}.`,
      "",
      "Enter it on the verification screen to finish setting up your account.",
      "The code expires in 10 minutes.",
      "",
      "If you didn't sign up for Saidrix, you can ignore this email.",
    ].join("\n"),
    html: renderEmail({
      preheader: `${code} — expires in 10 minutes.`,
      heading: "Confirm your email",
      paragraphs: [
        "You're one step from your first generated course. Enter this code on the verification screen:",
      ],
      code,
      note: "The code expires in 10 minutes. If you didn't sign up for Saidrix, you can safely ignore this email.",
    }),
  };
}

export function passwordResetEmail(link: string): Omit<MailInput, "to"> {
  return {
    subject: "Reset your Saidrix password",
    text: [
      "We received a request to reset your Saidrix password.",
      "",
      `Reset it here: ${link}`,
      "",
      "This link expires in 30 minutes and can only be used once.",
      "If you didn't request a reset, ignore this email — your password stays as it is.",
    ].join("\n"),
    html: renderEmail({
      preheader: "Reset your password — this link expires in 30 minutes.",
      heading: "Reset your password",
      paragraphs: ["We received a request to reset the password on your Saidrix account."],
      button: { label: "Choose a new password", url: link },
      note: "This link expires in 30 minutes and can only be used once. If you didn't request a reset, ignore this email — your password stays as it is.",
    }),
  };
}
