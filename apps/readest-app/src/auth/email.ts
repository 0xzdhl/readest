import nodemailer from 'nodemailer';
import { Resend } from 'resend';
import { env } from '@/env';

export interface SendEmailArgs {
  to: string;
  subject: string;
  html: string;
}

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
  const apiKey = env.RESEND_API_KEY;
  const from = env.RESEND_FROM_EMAIL;

  if (apiKey) {
    const resend = new Resend(apiKey);
    const result = await resend.emails.send({ from, to, subject, html });
    if (result.error) {
      throw new Error(`Resend send failed: ${result.error.message}`);
    }
    return;
  }

  const transport = nodemailer.createTransport({
    host: env.SMTP_HOST,
    port: env.SMTP_PORT,
    secure: false,
  });
  await transport.sendMail({ from, to, subject, html });
}
