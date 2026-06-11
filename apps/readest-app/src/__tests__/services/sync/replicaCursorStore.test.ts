import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { Hlc } from '@/types/replica';
import type { SystemSettings } from '@/domain/settings';

// Sentinel usecases: LoadSettings is a value, SaveSettings is a function
// that wraps its settings arg. The mocked runtime inspects which sentinel
// it received to dispatch load vs save without a real Effect runtime.
vi.mock('@/application/usecases/settings/LoadSettings', () => ({
  LoadSettings: { _tag: 'LoadSettings' },
}));
vi.mock('@/application/usecases/settings/SaveSettings', () => ({
  SaveSettings: (settings: SystemSettings) => ({ _tag: 'SaveSettings', settings }),
}));

const h = vi.hoisted(() => ({
  load: null as null | (() => Promise<SystemSettings>),
  save: null as null | ((s: SystemSettings) => Promise<void>),
}));

vi.mock('@/runtime/clientRuntime', () => ({
  getClientRuntime: () => ({
    runPromise: (effect: unknown) => {
      const e = effect as { _tag: string; settings?: SystemSettings };
      if (e._tag === 'LoadSettings') return h.load!();
      if (e._tag === 'SaveSettings') return h.save!(e.settings!);
      return Promise.reject(new Error(`unexpected effect ${e?._tag}`));
    },
  }),
}));

import { createSettingsCursorStore } from '@/services/sync/replicaCursorStore';

// Bridge-backed fake: load/save now flow through the mocked client runtime
// instead of an injected AppService. We keep the same in-memory settings
// semantics so the load-merge-save assertions are unchanged.
const makeFakeSettings = (initial: Partial<SystemSettings> = {}) => {
  let settings = { ...initial } as SystemSettings;
  const loadSettings = vi.fn(async () => settings);
  const saveSettings = vi.fn(async (s: SystemSettings) => {
    settings = { ...s };
  });
  h.load = loadSettings;
  h.save = saveSettings;
  return { loadSettings, saveSettings, getSettings: () => settings };
};

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  h.load = null;
  h.save = null;
});

describe('createSettingsCursorStore', () => {
  test('hydrates cache from settings.lastSyncedAtReplicas on init', async () => {
    makeFakeSettings({
      lastSyncedAtReplicas: { dictionary: 'cur-dict', font: 'cur-font' },
    });
    const store = createSettingsCursorStore();
    await vi.advanceTimersByTimeAsync(0);
    expect(store.get('dictionary')).toBe('cur-dict');
    expect(store.get('font')).toBe('cur-font');
  });

  test('get returns null when cursor not in settings', async () => {
    makeFakeSettings();
    const store = createSettingsCursorStore();
    await vi.advanceTimersByTimeAsync(0);
    expect(store.get('dictionary')).toBe(null);
  });

  test('set updates the cache synchronously', () => {
    makeFakeSettings();
    const store = createSettingsCursorStore();
    store.set('dictionary', 'cur-1' as Hlc);
    expect(store.get('dictionary')).toBe('cur-1');
  });

  test('set debounces a save flush; no save fires immediately', () => {
    const fake = makeFakeSettings({ replicaDeviceId: 'dev-a' });
    const store = createSettingsCursorStore({ debounceMs: 1000 });
    store.set('dictionary', 'cur-1' as Hlc);
    expect(fake.saveSettings).not.toHaveBeenCalled();
  });

  test('save fires after debounceMs', async () => {
    const fake = makeFakeSettings({ replicaDeviceId: 'dev-a' });
    const store = createSettingsCursorStore({ debounceMs: 1000 });
    store.set('dictionary', 'cur-1' as Hlc);
    await vi.advanceTimersByTimeAsync(999);
    expect(fake.saveSettings).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2);
    expect(fake.saveSettings).toHaveBeenCalledOnce();
    const saved = fake.saveSettings.mock.calls[0]![0];
    expect(saved.lastSyncedAtReplicas).toEqual({ dictionary: 'cur-1' });
  });

  test('successive sets within debounce window collapse to one save', async () => {
    const fake = makeFakeSettings();
    const store = createSettingsCursorStore({ debounceMs: 1000 });
    store.set('dictionary', 'a' as Hlc);
    await vi.advanceTimersByTimeAsync(500);
    store.set('dictionary', 'b' as Hlc);
    await vi.advanceTimersByTimeAsync(500);
    store.set('dictionary', 'c' as Hlc);
    await vi.advanceTimersByTimeAsync(1100);
    expect(fake.saveSettings).toHaveBeenCalledOnce();
    expect(fake.saveSettings.mock.calls[0]![0].lastSyncedAtReplicas).toEqual({ dictionary: 'c' });
  });

  test('save preserves other settings fields (load-merge-save round-trip)', async () => {
    const fake = makeFakeSettings({
      replicaDeviceId: 'dev-a',
      keepLogin: true,
    } as Partial<SystemSettings>);
    const store = createSettingsCursorStore({ debounceMs: 100 });
    await vi.advanceTimersByTimeAsync(0);
    store.set('dictionary', 'cur' as Hlc);
    await vi.advanceTimersByTimeAsync(110);
    const saved = fake.saveSettings.mock.calls[0]![0];
    expect(saved.replicaDeviceId).toBe('dev-a');
    expect(saved.keepLogin).toBe(true);
    expect(saved.lastSyncedAtReplicas).toEqual({ dictionary: 'cur' });
  });

  test('save preserves cursors for other kinds', async () => {
    const fake = makeFakeSettings({
      lastSyncedAtReplicas: { font: 'cur-font' },
    });
    const store = createSettingsCursorStore({ debounceMs: 100 });
    await vi.advanceTimersByTimeAsync(0);
    store.set('dictionary', 'cur-dict' as Hlc);
    await vi.advanceTimersByTimeAsync(110);
    const saved = fake.saveSettings.mock.calls[0]![0];
    expect(saved.lastSyncedAtReplicas).toEqual({ font: 'cur-font', dictionary: 'cur-dict' });
  });

  test('save error does not throw to caller (best-effort)', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fake = makeFakeSettings();
    fake.saveSettings.mockRejectedValueOnce(new Error('disk full'));
    const store = createSettingsCursorStore({ debounceMs: 100 });
    await vi.advanceTimersByTimeAsync(0);
    expect(() => store.set('dictionary', 'cur' as Hlc)).not.toThrow();
    await vi.advanceTimersByTimeAsync(110);
    await Promise.resolve();
  });

  test('hydrate failure does not break subsequent get/set', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fake = makeFakeSettings();
    fake.loadSettings.mockRejectedValueOnce(new Error('parse error'));
    const store = createSettingsCursorStore();
    await vi.advanceTimersByTimeAsync(0);
    expect(store.get('dictionary')).toBe(null);
    store.set('dictionary', 'cur' as Hlc);
    expect(store.get('dictionary')).toBe('cur');
  });
});
