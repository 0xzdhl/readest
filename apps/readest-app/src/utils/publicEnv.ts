export const readPublicEnv = (key: string): string | undefined => {
  if (
    typeof window !== 'undefined' &&
    (window as unknown as { __PUBLIC_ENV?: Record<string, string> }).__PUBLIC_ENV
  ) {
    return (window as unknown as { __PUBLIC_ENV?: Record<string, string> }).__PUBLIC_ENV?.[key];
  }
  return (import.meta as unknown as { env?: Record<string, string> }).env?.[key];
};

export const readPublicFlag = (key: string): boolean => {
  return readPublicEnv(key) === 'true';
};
