import { useEffect } from 'react';
import { usePlatformInfo } from '@/context/EffectRuntimeProvider';
import { useTrafficLightStore } from '@/store/trafficLightStore';

export const useTrafficLight = () => {
  const platformInfo = usePlatformInfo();

  const {
    isTrafficLightVisible,
    initializeTrafficLightStore,
    initializeTrafficLightListeners,
    setTrafficLightVisibility,
    cleanupTrafficLightListeners,
  } = useTrafficLightStore();

  useEffect(() => {
    if (!platformInfo.hasTrafficLight) return;

    initializeTrafficLightStore();
    initializeTrafficLightListeners();
    setTrafficLightVisibility(true, { x: 10, y: 20 });
    return () => {
      cleanupTrafficLightListeners();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [platformInfo.hasTrafficLight]);

  return { isTrafficLightVisible };
};
