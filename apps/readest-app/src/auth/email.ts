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
 * - Else when `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_EMAIL_API_TOKEN` are
 *   both set, use the Cloudflare Email Sending REST API (an HTTP `fetch`).
 *   This is the path for the Cloudflare Worker deployment: nodemailer SMTP
 *   relies on raw TCP sockets that workerd does not provide, so SMTP silently
 *   fails there. The REST API is plain HTTP and works in-Worker.
 * - Otherwise fall back to nodemailer SMTP (Mailpit by default,
 *   `SMTP_HOST` / `SMTP_PORT` override). `secure: true` for TLS.
 *   When `SMTP_AUTH_USER` and `SMTP_AUTH_TOKEN` are both set they are
 *   passed as `auth.user` / `auth.pass` to nodemailer. This path works on
 *   Node/Docker self-hosted builds (and local Mailpit), not on Workers.
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

  const cfAccountId = env.CLOUDFLARE_ACCOUNT_ID;
  const cfApiToken = env.CLOUDFLARE_EMAIL_API_TOKEN;

  if (cfAccountId && cfApiToken) {
    const response = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${cfAccountId}/email/sending/send`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${cfApiToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ from, to, subject, html }),
      },
    );
    // Cloudflare can signal failure via a non-2xx status or a `success: false`
    // body, so check both. Surface the API's error messages when present.
    const result = (await response.json().catch(() => null)) as {
      success?: boolean;
      errors?: { message?: string }[];
    } | null;
    if (!response.ok || !result?.success) {
      const detail =
        result?.errors
          ?.map((e) => e.message)
          .filter(Boolean)
          .join('; ') || `HTTP ${response.status}`;
      throw new Error(`Cloudflare Email Sending failed: ${detail}`);
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
