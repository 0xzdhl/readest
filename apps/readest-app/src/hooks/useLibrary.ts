import { useEffect, useRef, useState } from 'react';
import { Effect } from 'effect';
import { useRunEffect } from '@/context/EffectRuntimeProvider';
import { LibraryRepository } from '@/application/repositories/LibraryRepository';
import { SettingsRepository } from '@/application/repositories/SettingsRepository';
import { useLibraryStore } from '@/store/libraryStore';
import { useSettingsStore } from '@/store/settingsStore';

export const useLibrary = () => {
  const runEffect = useRunEffect();
  const { setLibrary, libraryLoaded: storeLibraryLoaded } = useLibraryStore();
  const { setSettings } = useSettingsStore();
  // Skip the disk reload when another mount has already populated the store —
  // re-reading would clobber transient in-memory entries (e.g. OPDS-PSE
  // streamed books) that aren't persisted to disk.
  const [libraryLoaded, setLibraryLoaded] = useState(storeLibraryLoaded);
  const isInitiating = useRef(false);

  useEffect(() => {
    if (isInitiating.current || storeLibraryLoaded) {
      if (storeLibraryLoaded && !libraryLoaded) {
        setLibraryLoaded(true);
      }
      return;
    }
    isInitiating.current = true;
    const initLibrary = async () => {
      const settings = await runEffect(Effect.flatMap(SettingsRepository, (r) => r.load));
      setSettings(settings);
      setLibrary(await runEffect(Effect.flatMap(LibraryRepository, (r) => r.load)));
      setLibraryLoaded(true);
    };

    initLibrary();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storeLibraryLoaded]);

  return { libraryLoaded };
};
