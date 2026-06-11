import type { Dispatch, SetStateAction } from 'react';
import { useRunEffect } from '@/context/EffectRuntimeProvider';
import { GetDefaultViewSettings } from '@/application/usecases/settings/GetDefaultViewSettings';
import type { ViewSettings } from '@/domain/book';

type SetterKey = keyof ViewSettings;
type SetterValue = SetStateAction<string> & SetStateAction<number> & SetStateAction<boolean>;

type StateSetters = Partial<{
  [Key in SetterKey]: Dispatch<SetterValue>;
}>;

export const useResetViewSettings = () => {
  const runEffect = useRunEffect();

  const resetToDefaults = (setters: StateSetters) => {
    runEffect(GetDefaultViewSettings).then((defaultSettings) => {
      Object.entries(setters).forEach(([settingKey, setter]) => {
        const freshValue = defaultSettings[settingKey as SetterKey];
        if (freshValue !== undefined) {
          setter(freshValue as SetterValue);
        }
      });
    });
  };

  return resetToDefaults;
};
