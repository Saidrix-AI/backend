/**
 * Branded HTML shell for transactional email.
 *
 * Constraints this is written against, which explain the shape of it:
 * - Layout is nested tables with inline styles. Gmail strips <style> blocks in
 *   several of its clients and none of them can be relied on for layout, so
 *   there is no stylesheet and no CSS class in here at all.
 * - No images, no web fonts, no external anything: remote images are blocked by
 *   default in most inboxes, which would leave the brand as a broken-image box.
 *   The wordmark is therefore set in type, and the palette is the app's warm
 *   paper one (frontend/src/index.css) hard-coded to hex.
 * - Every caller-supplied value is HTML-escaped on the way in.
 */

const FONT_STACK =
  "'Instrument Sans', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";
const MONO_STACK = "'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";

// Warm paper palette, mirroring the app's tokens.
const PAPER = "#f5f5f2";
const CARD = "#ffffff";
const BORDER = "#e3e2dd";
const SUNK = "#f2f2ee";
const INK = "#1c1c19";
const READ = "#3b3a35";
const MUTED = "#6c6b63";
const FAINT = "#a9a89e";

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export interface EmailContent {
  /** Inbox preview line. Shown next to the subject, never in the body itself. */
  preheader: string;
  heading: string;
  /** Body paragraphs, in order. Plain text — escaped for you. */
  paragraphs: string[];
  /** A verification code, rendered as the focal block. */
  code?: string;
  /** A call to action. The raw URL is repeated below it as a fallback. */
  button?: { label: string; url: string };
  /** Small print under the body — expiry, "wasn't you?", etc. */
  note?: string;
}

function paragraph(text: string): string {
  return `<p style="margin:0 0 14px;font-family:${FONT_STACK};font-size:15px;line-height:1.62;color:${READ};">${escapeHtml(text)}</p>`;
}

function codeBlock(code: string): string {
  return `
              <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin:22px 0 8px;">
                <tr>
                  <td align="center" style="background:${SUNK};border:1px solid ${BORDER};border-radius:12px;padding:22px 16px;">
                    <div style="font-family:${MONO_STACK};font-size:34px;font-weight:700;letter-spacing:10px;color:${INK};line-height:1;">${escapeHtml(code)}</div>
                  </td>
                </tr>
              </table>`;
}

function buttonBlock(label: string, url: string): string {
  const href = escapeHtml(url);
  return `
              <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:24px 0 12px;">
                <tr>
                  <td align="center" bgcolor="${INK}" style="border-radius:10px;">
                    <a href="${href}" style="display:inline-block;padding:14px 30px;font-family:${FONT_STACK};font-size:15px;font-weight:600;color:#ffffff;text-decoration:none;border-radius:10px;">${escapeHtml(label)}</a>
                  </td>
                </tr>
              </table>
              <p style="margin:0 0 4px;font-family:${FONT_STACK};font-size:12px;color:${MUTED};">Or paste this link into your browser:</p>
              <p style="margin:0 0 6px;font-family:${MONO_STACK};font-size:12px;line-height:1.5;word-break:break-all;"><a href="${href}" style="color:${READ};">${href}</a></p>`;
}

/** Wraps content in the Saidrix card. Returns a full HTML document. */
export function renderEmail(content: EmailContent): string {
  const { preheader, heading, paragraphs, code, button, note } = content;

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1" />
    <meta name="color-scheme" content="light" />
    <title>${escapeHtml(heading)}</title>
  </head>
  <body style="margin:0;padding:0;background:${PAPER};">
    <!-- Preheader: the grey line the inbox shows after the subject. The spacer
         keeps the client from pulling body copy up into it. -->
    <div style="display:none;max-height:0;overflow:hidden;opacity:0;">${escapeHtml(preheader)}</div>
    <div style="display:none;max-height:0;overflow:hidden;">&#8199;&#847;&#8199;&#847;&#8199;&#847;&#8199;&#847;&#8199;&#847;&#8199;&#847;&#8199;&#847;&#8199;&#847;&#8199;&#847;</div>

    <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:${PAPER};">
      <tr>
        <td align="center" style="padding:36px 16px;">
          <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="600" style="width:100%;max-width:600px;background:${CARD};border:1px solid ${BORDER};border-radius:14px;">
            <tr>
              <td style="padding:34px 38px 30px;">

                <div style="font-family:${MONO_STACK};font-size:11px;font-weight:700;letter-spacing:0.22em;text-transform:uppercase;color:${INK};">Saidrix</div>
                <div style="height:1px;background:${BORDER};margin:18px 0 26px;line-height:1px;font-size:0;">&nbsp;</div>

                <h1 style="margin:0 0 14px;font-family:${FONT_STACK};font-size:23px;line-height:1.3;font-weight:700;color:${INK};">${escapeHtml(heading)}</h1>
${paragraphs.map(paragraph).join("\n")}
${code ? codeBlock(code) : ""}
${button ? buttonBlock(button.label, button.url) : ""}
${note ? `<p style="margin:16px 0 0;font-family:${FONT_STACK};font-size:13px;line-height:1.6;color:${MUTED};">${escapeHtml(note)}</p>` : ""}

              </td>
            </tr>
            <tr>
              <td style="padding:0 38px 30px;">
                <div style="height:1px;background:${BORDER};margin:0 0 16px;line-height:1px;font-size:0;">&nbsp;</div>
                <p style="margin:0;font-family:${FONT_STACK};font-size:12px;line-height:1.6;color:${FAINT};">
                  Saidrix — your AI tutor. This is an automated message, so replies to it aren't read.
                </p>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;
}
