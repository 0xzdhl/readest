import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type ResendSendResult = { data: { id: string } | null; error: { message: string } | null };

const resendSendMock = vi.hoisted(() =>
  vi.fn<(payload: { from: string; to: string; subject: string; html: string }) => Promise<unknown>>(
    async () => ({ data: { id: 'msg_123' }, error: null }) satisfies ResendSendResult,
  ),
);
const ResendCtorMock = vi.hoisted(() =>
  vi.fn(function ResendCtor(this: { emails: { send: typeof resendSendMock } }) {
    this.emails = { send: resendSendMock };
  }),
);

const sendMailMock = vi.hoisted(() =>
  vi.fn<(payload: { from: string; to: string; subject: string; html: string }) => Promise<unknown>>(
    async () => ({ messageId: 'local-1' }),
  ),
);
const createTransportMock = vi.hoisted(() =>
  vi.fn<
    (config: {
      host: string;
      port: number;
      secure: boolean;
      auth?: { user: string; pass: string };
    }) => unknown
  >(() => ({
    sendMail: sendMailMock,
  })),
);

const fetchMock = vi.hoisted(() =>
  vi.fn<(url: string, init: RequestInit) => Promise<Response>>(
    async () =>
      new Response(
        JSON.stringify({
          success: true,
          errors: [],
          result: { delivered: ['user@example.com'], permanent_bounces: [], queued: [] },
        }),
        { status: 200 },
      ),
  ),
);

vi.mock('resend', () => ({ Resend: ResendCtorMock }));
vi.mock('nodemailer', () => ({
  default: { createTransport: createTransportMock },
  createTransport: createTransportMock,
}));

/**
 * Read the typed first argument of the Nth call to a vi.fn. Throws if the
 * call hasn't happened — that's exactly the assertion we want from a test
 * (no silent `undefined`).
 */
function firstArgOf<TArgs extends unknown[]>(
  mock: { mock: { calls: TArgs[] } },
  callIndex: number,
): TArgs[0] {
  const call = mock.mock.calls[callIndex];
  if (!call) {
    throw new Error(`Expected mock to have been called at least ${callIndex + 1} times`);
  }
  return call[0];
}

/** Like `firstArgOf`, but returns the first two positional arguments. */
function firstTwoArgsOf<TArgs extends unknown[]>(
  mock: { mock: { calls: TArgs[] } },
  callIndex: number,
): [TArgs[0], TArgs[1]] {
  const call = mock.mock.calls[callIndex];
  if (!call) {
    throw new Error(`Expected mock to have been called at least ${callIndex + 1} times`);
  }
  return [call[0], call[1]];
}

describe('sendEmail', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.resetModules();
    resendSendMock.mockClear();
    ResendCtorMock.mockClear();
    sendMailMock.mockClear();
    createTransportMock.mockClear();
    fetchMock.mockClear();
    vi.stubGlobal('fetch', fetchMock);
    delete process.env['RESEND_API_KEY'];
    delete process.env['CLOUDFLARE_ACCOUNT_ID'];
    delete process.env['CLOUDFLARE_EMAIL_API_TOKEN'];
    // SMTP_FROM_EMAIL is a required env var (no schema default), so a valid
    // baseline must be present for `@/env` to validate on import. Tests that
    // assert the `from` address override it explicitly.
    process.env['SMTP_FROM_EMAIL'] = 'noreply@example.com';
    delete process.env['SMTP_HOST'];
    delete process.env['SMTP_PORT'];
    delete process.env['SMTP_AUTH_USER'];
    delete process.env['SMTP_AUTH_TOKEN'];
    process.env['DATABASE_URL'] = 'postgres://postgres:postgres@localhost:5432/postgres';
    process.env['BETTER_AUTH_SECRET'] = 'test-secret';
    process.env['BETTER_AUTH_URL'] = 'http://localhost:5173';
    process.env['VITE_APP_PLATFORM'] = 'web';
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.unstubAllGlobals();
  });

  it('uses the Resend SDK when RESEND_API_KEY is set', async () => {
    process.env['RESEND_API_KEY'] = 'test-api-key';
    process.env['SMTP_FROM_EMAIL'] = 'sender@example.com';

    const { sendEmail } = await import('@/auth/email');
    await sendEmail({
      to: 'user@example.com',
      subject: 'hi',
      html: '<p>hi</p>',
    });

    expect(ResendCtorMock).toHaveBeenCalledTimes(1);
    expect(ResendCtorMock).toHaveBeenCalledWith('test-api-key');
    expect(resendSendMock).toHaveBeenCalledTimes(1);
    const arg = firstArgOf(resendSendMock, 0);
    expect(arg.from).toBe('sender@example.com');
    expect(arg.to).toBe('user@example.com');
    expect(arg.subject).toBe('hi');
    expect(arg.html).toBe('<p>hi</p>');
    expect(createTransportMock).not.toHaveBeenCalled();
  });

  it('throws when the Resend response carries an error', async () => {
    process.env['RESEND_API_KEY'] = 'test-api-key';
    resendSendMock.mockResolvedValueOnce({
      data: null,
      error: { message: 'boom' },
    } satisfies ResendSendResult);

    const { sendEmail } = await import('@/auth/email');
    await expect(sendEmail({ to: 'user@example.com', subject: 's', html: 'h' })).rejects.toThrow(
      /boom/,
    );
  });

  it('uses the Cloudflare Email Sending REST API when account id and token are set', async () => {
    process.env['CLOUDFLARE_ACCOUNT_ID'] = 'acc_123';
    process.env['CLOUDFLARE_EMAIL_API_TOKEN'] = 'cf-token';
    process.env['SMTP_FROM_EMAIL'] = 'sender@example.com';

    const { sendEmail } = await import('@/auth/email');
    await sendEmail({ to: 'user@example.com', subject: 'hi', html: '<p>hi</p>' });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = firstTwoArgsOf(fetchMock, 0);
    expect(url).toBe('https://api.cloudflare.com/client/v4/accounts/acc_123/email/sending/send');
    expect(init.method).toBe('POST');
    const headers = init.headers as Record<string, string>;
    expect(headers['Authorization']).toBe('Bearer cf-token');
    expect(headers['Content-Type']).toBe('application/json');
    const body = JSON.parse(init.body as string) as {
      from: string;
      to: string;
      subject: string;
      html: string;
    };
    expect(body.from).toBe('sender@example.com');
    expect(body.to).toBe('user@example.com');
    expect(body.subject).toBe('hi');
    expect(body.html).toBe('<p>hi</p>');

    // The Cloudflare path short-circuits before the SMTP/Resend fallbacks.
    expect(createTransportMock).not.toHaveBeenCalled();
    expect(ResendCtorMock).not.toHaveBeenCalled();
  });

  it('throws when the Cloudflare REST response reports failure', async () => {
    process.env['CLOUDFLARE_ACCOUNT_ID'] = 'acc_123';
    process.env['CLOUDFLARE_EMAIL_API_TOKEN'] = 'cf-token';
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          success: false,
          errors: [{ code: 1000, message: 'Sender domain not verified' }],
          result: null,
        }),
        { status: 400 },
      ),
    );

    const { sendEmail } = await import('@/auth/email');
    await expect(sendEmail({ to: 'u@e.com', subject: 's', html: 'h' })).rejects.toThrow(
      /Sender domain not verified/,
    );
    expect(createTransportMock).not.toHaveBeenCalled();
  });

  it('prefers Resend over the Cloudflare REST API when both are configured', async () => {
    process.env['RESEND_API_KEY'] = 'test-api-key';
    process.env['CLOUDFLARE_ACCOUNT_ID'] = 'acc_123';
    process.env['CLOUDFLARE_EMAIL_API_TOKEN'] = 'cf-token';

    const { sendEmail } = await import('@/auth/email');
    await sendEmail({ to: 'user@example.com', subject: 'hi', html: '<p>hi</p>' });

    expect(resendSendMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('falls back to nodemailer SMTP when RESEND_API_KEY is unset', async () => {
    process.env['SMTP_HOST'] = 'mailpit';
    process.env['SMTP_PORT'] = '2025';

    const { sendEmail } = await import('@/auth/email');
    await sendEmail({
      to: 'user@example.com',
      subject: 'fallback',
      html: '<p>fallback</p>',
    });

    expect(createTransportMock).toHaveBeenCalledTimes(1);
    const transportConfig = firstArgOf(createTransportMock, 0);
    expect(transportConfig.host).toBe('mailpit');
    expect(transportConfig.port).toBe(2025);
    expect(transportConfig.secure).toBe(true);

    expect(sendMailMock).toHaveBeenCalledTimes(1);
    const mailArg = firstArgOf(sendMailMock, 0);
    expect(mailArg.to).toBe('user@example.com');
    expect(mailArg.subject).toBe('fallback');
    expect(mailArg.html).toBe('<p>fallback</p>');
    expect(ResendCtorMock).not.toHaveBeenCalled();
  });

  it('passes SMTP auth credentials to nodemailer when both SMTP_AUTH_USER and SMTP_AUTH_TOKEN are set', async () => {
    process.env['SMTP_HOST'] = 'smtp.example.com';
    process.env['SMTP_PORT'] = '587';
    process.env['SMTP_AUTH_USER'] = 'api';
    process.env['SMTP_AUTH_TOKEN'] = 'secret';

    const { sendEmail } = await import('@/auth/email');
    await sendEmail({ to: 'user@example.com', subject: 's', html: 'h' });

    expect(createTransportMock).toHaveBeenCalledTimes(1);
    const transportConfig = firstArgOf(createTransportMock, 0);
    expect(transportConfig.auth).toEqual({ user: 'api', pass: 'secret' });
  });

  it('omits auth from nodemailer transport when SMTP_AUTH_TOKEN is missing', async () => {
    process.env['SMTP_HOST'] = 'smtp.example.com';
    process.env['SMTP_PORT'] = '587';
    process.env['SMTP_AUTH_USER'] = 'api';
    // SMTP_AUTH_TOKEN left unset (deleted in beforeEach)

    const { sendEmail } = await import('@/auth/email');
    await sendEmail({ to: 'user@example.com', subject: 's', html: 'h' });

    expect(createTransportMock).toHaveBeenCalledTimes(1);
    const transportConfig = firstArgOf(createTransportMock, 0);
    expect(transportConfig.auth).toBeUndefined();
  });

  it('defaults SMTP host to localhost:1025 (mailpit) when unset', async () => {
    const { sendEmail } = await import('@/auth/email');
    await sendEmail({ to: 'u@e.com', subject: 's', html: 'h' });

    expect(createTransportMock).toHaveBeenCalledTimes(1);
    const transportConfig = firstArgOf(createTransportMock, 0);
    expect(transportConfig.host).toBe('localhost');
    expect(transportConfig.port).toBe(1025);
  });
});
