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
  vi.fn<(config: { host: string; port: number; secure: boolean }) => unknown>(() => ({
    sendMail: sendMailMock,
  })),
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

describe('sendEmail', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.resetModules();
    resendSendMock.mockClear();
    ResendCtorMock.mockClear();
    sendMailMock.mockClear();
    createTransportMock.mockClear();
    delete process.env['RESEND_API_KEY'];
    delete process.env['RESEND_FROM_EMAIL'];
    delete process.env['SMTP_HOST'];
    delete process.env['SMTP_PORT'];
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('uses the Resend SDK when RESEND_API_KEY is set', async () => {
    process.env['RESEND_API_KEY'] = 'test-api-key';
    process.env['RESEND_FROM_EMAIL'] = 'sender@example.com';

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
    await expect(
      sendEmail({ to: 'user@example.com', subject: 's', html: 'h' }),
    ).rejects.toThrow(/boom/);
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
    expect(transportConfig.secure).toBe(false);

    expect(sendMailMock).toHaveBeenCalledTimes(1);
    const mailArg = firstArgOf(sendMailMock, 0);
    expect(mailArg.to).toBe('user@example.com');
    expect(mailArg.subject).toBe('fallback');
    expect(mailArg.html).toBe('<p>fallback</p>');
    expect(ResendCtorMock).not.toHaveBeenCalled();
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
