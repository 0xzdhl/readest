import type React from 'react';
import { MdOutlineLightMode, MdOutlineDarkMode } from 'react-icons/md';
import { TbSunMoon } from 'react-icons/tb';
import { useTranslation } from '@/hooks/useTranslation';
import { useAtmosphereStore } from '@/store/atmosphereStore';
import { SettingsRow } from '../primitives';

interface ThemeModeSelectorProps {
  themeMode: 'auto' | 'light' | 'dark';
  onThemeModeChange: (mode: 'auto' | 'light' | 'dark') => void;
  'data-setting-id'?: string;
}

const ThemeModeSelector: React.FC<ThemeModeSelectorProps> = ({
  themeMode,
  onThemeModeChange,
  'data-setting-id': dataSettingId,
}) => {
  const _ = useTranslation();
  const { spinDirection, shaking, toggle, toggleWithShake, deactivate } = useAtmosphereStore();

  const handleLightClick = () => {
    if (themeMode === 'light') {
      toggle();
    } else {
      deactivate();
      onThemeModeChange('light');
    }
  };

  const handleDarkClick = () => {
    if (themeMode === 'dark') {
      toggleWithShake();
    } else {
      deactivate();
      onThemeModeChange('dark');
    }
  };

  const handleAutoClick = () => {
    deactivate();
    onThemeModeChange('auto');
  };

  return (
    <SettingsRow label={_('Theme Mode')} data-setting-id={dataSettingId}>
      <div className='flex gap-4'>
        <button
          title={_('Auto Mode')}
          className={`btn btn-ghost btn-circle btn-sm ${themeMode === 'auto' ? 'btn-active bg-base-300' : ''}`}
          onClick={handleAutoClick}
        >
          <TbSunMoon />
        </button>
        <button
          title={_('Light Mode')}
          className={`btn btn-ghost btn-circle btn-sm ${themeMode === 'light' ? 'btn-active bg-base-300' : ''}`}
          onClick={handleLightClick}
        >
          <span
            className={
              spinDirection === 'cw'
                ? 'animate-spin-cw'
                : spinDirection === 'ccw'
                  ? 'animate-spin-ccw'
                  : ''
            }
          >
            <MdOutlineLightMode />
          </span>
        </button>
        <button
          title={_('Dark Mode')}
          className={`btn btn-ghost btn-circle btn-sm ${themeMode === 'dark' ? 'btn-active bg-base-300' : ''}`}
          onClick={handleDarkClick}
        >
          <span className={shaking ? 'animate-shake' : ''}>
            <MdOutlineDarkMode />
          </span>
        </button>
      </div>
    </SettingsRow>
  );
};

export default ThemeModeSelector;
