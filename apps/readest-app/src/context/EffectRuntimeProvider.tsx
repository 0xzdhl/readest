import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import type { Effect } from 'effect';
import { type ClientServices, getClientRuntime, getPlatformInfo } from '@/runtime/clientRuntime';
import type { PlatformInfo } from '@/application/ports/Platform';
import type { SystemSettings } from '@/domain/settings';
import { BootApp } from '@/application/usecases/boot/BootApp';
import env from '@/services/environment';
import { bootstrapReplicaAdapters } from '@/services/sync/replicaBootstrap';
import { enableReplicaAutoPersist } from '@/services/sync/replicaPersist';
import { createSettingsCursorStore } from '@/services/sync/replicaCursorStore';
import { initReplicaSync } from '@/services/sync/replicaSync';
import { startReplicaTransferIntegration } from '@/services/sync/replicaTransferIntegration';

// The provided runtime is a `ManagedRuntime<ClientServices, never>`, so it can run any effect
// whose requirements are satisfied by those port/usecase services. Accept that requirement set
// (not just `never`) so usecases like `LoadSettings` (R = SettingsRepository) typecheck.
type RunEffect = <A, E>(program: Effect.Effect<A, E, ClientServices>) => Promise<A>;

interface RuntimeContextValue {
  readonly platformInfo: PlatformInfo;
  readonly runEffect: RunEffect;
  readonly booted: boolean;
  readonly bootSettings: SystemSettings | null;
}

const RuntimeContext = createContext<RuntimeContextValue | null>(null);

export function EffectRuntimeProvider({ children }: { children: ReactNode }) {
  const platformInfo = getPlatformInfo(); // sync (SSR-safe defaults)
  const runEffect = useCallback<RunEffect>((program) => getClientRuntime().runPromise(program), []);
  const [booted, setBooted] = useState(false);
  const [bootSettings, setBootSettings] = useState<SystemSettings | null>(null);

  const started = useRef(false);
  useEffect(() => {
    if (started.current || typeof window === 'undefined') return;
    started.current = true;
    // Authoritative boot: load platform+settings, apply customRootDir, run
    // migrations (version-idempotent), then flip `booted`. On failure leave
    // booted=false (faithful to the legacy null-appService pre-boot state).
    getClientRuntime()
      .runPromise(BootApp)
      .then((r) => {
        setBootSettings(r.settings);
        setBooted(true);
        bootstrapReplicaAdapters();
        enableReplicaAutoPersist(env);
        try {
          if (r.settings.replicaDeviceId) {
            const ctx = initReplicaSync({
              deviceId: r.settings.replicaDeviceId,
              cursorStore: createSettingsCursorStore(),
            });
            ctx.manager.startAutoSync();
            startReplicaTransferIntegration();
          }
        } catch (err) {
          console.warn('replica sync init failed', err);
        }
      })
      .catch((err) => console.warn('[EffectBoot] failed (non-fatal)', err));
  }, []);

  return (
    <RuntimeContext.Provider value={{ platformInfo, runEffect, booted, bootSettings }}>
      {children}
    </RuntimeContext.Provider>
  );
}

// These hooks degrade gracefully to the module-level singleton when rendered
// outside the provider — e.g. a component mounted above the provider, or a unit
// test that doesn't wrap in <EffectRuntimeProvider>. In the real app the provider
// supplies the same value (it computes platformInfo from getPlatformInfo() and runs
// on the same client runtime), so behavior is identical; the fallback just removes a
// hard context dependency and matches the legacy null-tolerant appService.
export const useRunEffect = (): RunEffect => {
  const ctx = useContext(RuntimeContext);
  return ctx?.runEffect ?? ((program) => getClientRuntime().runPromise(program));
};
export const usePlatformInfo = (): PlatformInfo => {
  const ctx = useContext(RuntimeContext);
  return ctx?.platformInfo ?? getPlatformInfo();
};
export const useBooted = (): boolean => {
  const ctx = useContext(RuntimeContext);
  return ctx?.booted ?? false;
};
export const useBootSettings = (): SystemSettings | null => {
  const ctx = useContext(RuntimeContext);
  return ctx?.bootSettings ?? null;
};
