import type { Request, Response } from "express";
import { env } from "../config/env.js";
import { UserModel } from "../database/models/user.model.js";
import { renderEmail } from "../utils/emailTemplate.js";
import { logger } from "../utils/logger.js";
import { sendMail } from "../utils/mailer.js";

/**
 * The contact forms — the landing page's and the one in the Account Center.
 *
 * A public endpoint that sends mail is a spam relay unless three things hold,
 * so they are all done here rather than trusted to a caller:
 *
 *   1. The recipient is `CONTACT_INBOX` and never anything from the request.
 *      A caller-supplied recipient would let anyone send mail from our domain
 *      to any address, which costs the sending reputation that signup and
 *      password-reset mail depends on.
 *   2. `from` stays `MAIL_FROM`. The visitor's address goes in `Reply-To`, so
 *      hitting reply reaches them without us ever claiming to be them.
 *   3. Anything that lands in a header is stripped of CR and LF first. A
 *      newline inside an address or subject is how header injection adds its
 *      own recipients.
 *
 * The message body is not a header, so it keeps its newlines — it goes through
 * `renderEmail`, which escapes every paragraph it is given.
 */

const CATEGORY_LABELS: Record<string, string> = {
  general: "General Inquiry",
  technical: "Technical Support",
  billing: "Billing & Payments",
  account: "Account & Plans",
  other: "Other",
};

/**
 * Makes a value safe to put in a mail header.
 *
 * Strips CR/LF (and the NUL some parsers still split on), collapses the
 * whitespace that leaves behind, and caps the length. Without this, a "name" of
 * `x\r\nBcc: victim@example.com` becomes a second recipient.
 */
function headerSafe(value: string, max = 200): string {
  return value
    .replace(/[\r\n\0]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

/**
 * A display name that cannot change how an address header parses.
 *
 * `headerSafe` alone stops the injection — with no newline there is no second
 * header — but it still lets `Ada Bcc: victim@example.com` through as a name,
 * and that is a string some parsers will tokenize in ways we did not intend.
 * The characters removed here are the ones that mean something structurally in
 * an address list.
 *
 * Belt and braces: the address is also passed to nodemailer structurally, so it
 * quotes the name itself. Neither measure relies on the other.
 */
function displayName(value: string): string {
  return headerSafe(value.replace(/[<>,;:"\\]/g, " "), 100) || "Saidrix visitor";
}

export async function submit(req: Request, res: Response): Promise<void> {
  const body = req.body as {
    name: string;
    email: string;
    subject: string;
    message: string;
    category?: string;
  };

  // A signed-in sender is identified from their session, not from what they
  // posted — the form fields are prefilled and editable, so on their own they
  // are untrusted display text. Anonymous senders have only what they typed,
  // which is why the address is echoed as "unverified" below.
  const account = req.user?.id
    ? await UserModel.findById(req.user.id).select("name email username").lean()
    : null;

  const senderName = displayName(account?.name || body.name);
  const senderEmail = headerSafe(account?.email || body.email, 200);
  const subject = headerSafe(body.subject, 150);
  const category = CATEGORY_LABELS[body.category ?? ""] ?? "General Inquiry";

  const origin = account
    ? `Signed in as @${account.username} (${account.email}) — address verified by the session.`
    : "Sent from the public contact form. The address below is UNVERIFIED — anyone can type it.";

  const text = [
    `From: ${senderName} <${senderEmail}>`,
    `Category: ${category}`,
    `Subject: ${subject}`,
    "",
    body.message,
    "",
    "—",
    origin,
  ].join("\n");

  await sendMail({
    // Fixed. See the note at the top of this file.
    to: env.CONTACT_INBOX,
    subject: `[Saidrix ${category}] ${subject}`,
    text,
    html: renderEmail({
      preheader: `${senderName}: ${subject}`,
      heading: subject,
      // renderEmail escapes each paragraph, so the message goes in raw.
      paragraphs: [`${senderName} <${senderEmail}> · ${category}`, body.message, origin],
    }),
    // Reply reaches the visitor; `from` is still us. Structured rather than
    // concatenated so nodemailer owns the quoting — see MailInput.replyTo.
    replyTo: { name: senderName, address: senderEmail },
  });

  logger.info(
    { category, authenticated: Boolean(account) },
    "[contact] message received and forwarded",
  );

  res.json({ success: true, data: { received: true } });
}
