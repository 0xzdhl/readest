import nodemailer from 'nodemailer';
import { Resend } from 'resend';

export interface SendEmailArgs {
  to: string;
  subject: string;
  html: string;
}

const DEFAULT_FROM = 'noreply@readest.app';

/**
 * Send a transactional email.
 *
 * Routing rules:
 * - When `RESEND_API_KEY` is set, use the Resend HTTP API.
 *   `RESEND_FROM_EMAIL` overrides the default `from`.
 * - Otherwise fall back to nodemailer SMTP (Mailpit by default,
 *   `SMTP_HOST` / `SMTP_PORT` override). `secure: false` — Mailpit
 *   does not negotiate TLS.
 *
 * Used by better-auth's magic-link, email-verification, and
 * password-reset callbacks (see `auth/server.ts`).
 */
export async function sendEmail({ to, subject, html }: SendEmailArgs): Promise<void> {
  const apiKey = process.env['RESEND_API_KEY'];
  const from = process.env['RESEND_FROM_EMAIL'] ?? DEFAULT_FROM;

  if (apiKey) {
    const resend = new Resend(apiKey);
    const result = await resend.emails.send({ from, to, subject, html });
    if (result.error) {
      const message =
        typeof result.error === 'object' && result.error !== null && 'message' in result.error
          ? String((result.error as { message: unknown }).message)
          : 'Unknown Resend error';
      throw new Error(`Resend send failed: ${message}`);
    }
    return;
  }

  const host = process.env['SMTP_HOST'] ?? 'localhost';
  const port = Number.parseInt(process.env['SMTP_PORT'] ?? '', 10) || 1025;
  const transport = nodemailer.createTransport({ host, port, secure: false });
  await transport.sendMail({ from, to, subject, html });
}
