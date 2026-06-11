import React, { createContext, type ReactNode, useContext, useMemo, useState } from 'react';
import env, { type EnvConfigType } from '../services/environment';

interface EnvContextType {
  envConfig: EnvConfigType;
}

const EnvContext = createContext<EnvContextType | undefined>(undefined);

export const EnvProvider = ({ children }: { children: ReactNode }) => {
  const [envConfig] = useState<EnvConfigType>(env);

  React.useEffect(() => {
    window.addEventListener('error', (e) => {
      if (e.message === 'ResizeObserver loop limit exceeded') {
        e.stopImmediatePropagation();
        e.preventDefault();
        return true;
      }
      return false;
    });
  }, []);

  const value = useMemo(() => ({ envConfig }), [envConfig]);
  return <EnvContext.Provider value={value}>{children}</EnvContext.Provider>;
};

export const useEnv = (): EnvContextType => {
  const context = useContext(EnvContext);
  if (!context) {
    if (typeof document === 'undefined') {
      return { envConfig: {} as EnvConfigType };
    }
    throw new Error('useEnv must be used within EnvProvider');
  }
  return context;
};
