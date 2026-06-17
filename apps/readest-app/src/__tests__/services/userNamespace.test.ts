import { describe, it, expect, beforeEach } from 'vitest';
import {
  getCurrentUserNamespace,
  setCurrentUserNamespace,
  subscribeUserNamespace,
  LOCAL_NAMESPACE,
} from '@/services/userNamespace';

describe('userNamespace', () => {
  beforeEach(() => setCurrentUserNamespace(null));
  it('defaults to local', () => {
    expect(getCurrentUserNamespace()).toBe(LOCAL_NAMESPACE);
  });
  it('returns the user id when set', () => {
    setCurrentUserNamespace('user-A');
    expect(getCurrentUserNamespace()).toBe('user-A');
  });
  it('falls back to local on null/empty', () => {
    setCurrentUserNamespace('user-A');
    setCurrentUserNamespace('');
    expect(getCurrentUserNamespace()).toBe(LOCAL_NAMESPACE);
  });
  it('notifies subscribers only on change', () => {
    const seen: string[] = [];
    const off = subscribeUserNamespace((ns) => seen.push(ns));
    setCurrentUserNamespace('user-A');
    setCurrentUserNamespace('user-A');
    setCurrentUserNamespace('user-B');
    off();
    setCurrentUserNamespace('user-C');
    expect(seen).toEqual(['user-A', 'user-B']);
  });
});
