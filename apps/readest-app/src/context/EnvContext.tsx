import React, { createContext, type ReactNode, useContext, useMemo, useState } from 'react';
import { bootstrapReplicaAdapters } from '@/services/sync/replicaBootstrap';
import { createSettingsCursorStore } from '@/services/sync/replicaCursorStore';
import { enableReplicaAutoPersist } from '@/services/sync/replicaPersist';
import { initReplicaSync } from '@/services/sync/replicaSync';
import { startReplicaTransferIntegration } from '@/services/sync/replicaTransferIntegration';
import type { AppService } from '@/types/system';
import env, { type EnvConfigType } from '../services/environment';

interface EnvContextType {
  envConfig: EnvConfigType;
  appService: AppService | null;
}

const EnvContext = createContext<EnvContextType | undefined>(undefined);

export const EnvProvider = ({ children }: { children: ReactNode }) => {
  const [envConfig] = useState<EnvConfigType>(env);
  const [appService, setAppService] = useState<AppService | null>(null);

  React.useEffect(() => {
    bootstrapReplicaAdapters();
    enableReplicaAutoPersist(envConfig);
    envConfig.getAppService().then(async (service) => {
      setAppService(service);
      try {
        const settings = await service.loadSettings();
        if (settings.replicaDeviceId) {
          const ctx = initReplicaSync({
            deviceId: settings.replicaDeviceId,
            cursorStore: createSettingsCursorStore(service),
          });
          ctx.manager.startAutoSync();
          startReplicaTransferIntegration(service);
        }
      } catch (err) {
        console.warn('replica sync init failed', err);
      }
    });
    window.addEventListener('error', (e) => {
      if (e.message === 'ResizeObserver loop limit exceeded') {
        e.stopImmediatePropagation();
        e.preventDefault();
        return true;
      }
      return false;
    });
  }, [envConfig]);

  const value = useMemo(() => ({ envConfig, appService }), [envConfig, appService]);
  return <EnvContext.Provider value={value}>{children}</EnvContext.Provider>;
};

export const useEnv = (): EnvContextType => {
  const context = useContext(EnvContext);
  if (!context) {
    if (typeof document === 'undefined') {
      // SSR: return a bare-minimum fallback instead of throwing.
      // EnvProvider's useEffect doesn't run during SSR, so the real
      // appService is never available on the server.
      return { envConfig: {} as EnvConfigType, appService: null };
    }
    throw new Error('useEnv must be used within EnvProvider');
  }
  return context;
};
