import { createContext, useCallback, useContext, useEffect, useRef, type ReactNode } from 'react';
import type { Effect } from 'effect';
import { type ClientServices, getClientRuntime, getPlatformInfo } from '@/runtime/clientRuntime';
import type { PlatformInfo } from '@/application/ports/Platform';
import { BootApp } from '@/application/usecases/boot/BootApp';

// The provided runtime is a `ManagedRuntime<ClientServices, never>`, so it can run any effect
// whose requirements are satisfied by those port/usecase services. Accept that requirement set
// (not just `never`) so usecases like `LoadSettings` (R = SettingsRepository) typecheck.
type RunEffect = <A, E>(program: Effect.Effect<A, E, ClientServices>) => Promise<A>;

interface RuntimeContextValue {
  readonly platformInfo: PlatformInfo;
  readonly runEffect: RunEffect;
}

const RuntimeContext = createContext<RuntimeContextValue | null>(null);

export function EffectRuntimeProvider({ children }: { children: ReactNode }) {
  const platformInfo = getPlatformInfo(); // sync (SSR-safe defaults)
  const runEffect = useCallback<RunEffect>((program) => getClientRuntime().runPromise(program), []);

  const booted = useRef(false);
  useEffect(() => {
    if (booted.current || typeof window === 'undefined') return;
    booted.current = true;
    // Observe-only: prove the runtime boots end-to-end; do NOT gate the shell.
    getClientRuntime()
      .runPromise(BootApp)
      .then((r) => console.debug('[EffectBoot] booted', r.platform.appPlatform))
      .catch((err) => console.warn('[EffectBoot] failed (non-fatal)', err));
  }, []);

  return (
    <RuntimeContext.Provider value={{ platformInfo, runEffect }}>
      {children}
    </RuntimeContext.Provider>
  );
}

function useRuntimeContext(): RuntimeContextValue {
  const ctx = useContext(RuntimeContext);
  if (!ctx) throw new Error('must be used within <EffectRuntimeProvider>');
  return ctx;
}

export const useRunEffect = (): RunEffect => useRuntimeContext().runEffect;
export const usePlatformInfo = (): PlatformInfo => useRuntimeContext().platformInfo;
