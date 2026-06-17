export const LOCAL_NAMESPACE = 'local';

let currentNamespace = LOCAL_NAMESPACE;
const subscribers = new Set<(ns: string) => void>();

export const getCurrentUserNamespace = (): string => currentNamespace;

export const setCurrentUserNamespace = (userId: string | null): void => {
  const next = userId && userId.length > 0 ? userId : LOCAL_NAMESPACE;
  if (next === currentNamespace) return;
  currentNamespace = next;
  for (const cb of subscribers) cb(next);
};

export const subscribeUserNamespace = (cb: (ns: string) => void): (() => void) => {
  subscribers.add(cb);
  return () => subscribers.delete(cb);
};
