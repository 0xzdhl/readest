import { env } from '@/env';

export const readPublicEnv = (key: string): string | undefined => {
  if (
    typeof window !== 'undefined' &&
    (window as unknown as { __PUBLIC_ENV?: Record<string, string> }).__PUBLIC_ENV
  ) {
    return (window as unknown as { __PUBLIC_ENV?: Record<string, string> }).__PUBLIC_ENV?.[key];
  }
  const value = (env as Record<string, unknown>)[key];
  return value === undefined ? undefined : String(value);
};

export const readPublicFlag = (key: string): boolean => {
  return readPublicEnv(key) === 'true';
};
