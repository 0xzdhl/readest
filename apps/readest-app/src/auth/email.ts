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
 *   `SMTP_FROM_EMAIL` sets the sender address.
 * - Otherwise fall back to nodemailer SMTP (Mailpit by default,
 *   `SMTP_HOST` / `SMTP_PORT` override). `secure: true` for TLS.
 *   When `SMTP_AUTH_USER` and `SMTP_AUTH_TOKEN` are both set they are
 *   passed as `auth.user` / `auth.pass` to nodemailer.
 *
 * Used by better-auth's magic-link, email-verification, and
 * password-reset callbacks (see `auth/server.ts`).
 */
export async function sendEmail({ to, subject, html }: SendEmailArgs): Promise<void> {
  const apiKey = env.RESEND_API_KEY;
  const from = env.SMTP_FROM_EMAIL;

  if (apiKey) {
    const resend = new Resend(apiKey);
    const result = await resend.emails.send({ from, to, subject, html });
    if (result.error) {
      throw new Error(`Resend send failed: ${result.error.message}`);
    }
    return;
  }

  const authUser = env.SMTP_AUTH_USER;
  const authToken = env.SMTP_AUTH_TOKEN;

  const transport = nodemailer.createTransport({
    host: env.SMTP_HOST,
    port: env.SMTP_PORT,
    secure: true,
    ...(authUser && authToken ? { auth: { user: authUser, pass: authToken } } : {}),
  });
  await transport.sendMail({ from, to, subject, html });
}
