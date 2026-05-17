import { useEffect } from 'react';
import { useEnv } from '@/context/EnvContext';
import { checkForAppUpdates, checkAppReleaseNotes } from '@/helpers/updater';
import { useAppUrlIngress } from '@/hooks/useAppUrlIngress';
import { useOpenAnnotationLink } from '@/hooks/useOpenAnnotationLink';
import { useOpenShareLink } from '@/hooks/useOpenShareLink';
import { useOpenWithBooks } from '@/hooks/useOpenWithBooks';
import { useTranslation } from '@/hooks/useTranslation';
import { useSettingsStore } from '@/store/settingsStore';
import { tauriHandleSetAlwaysOnTop } from '@/utils/window';
import Reader from './components/Reader';

type ReaderRoutePageProps = {
  ids: string;
  cfi?: string;
};

export function ReaderRoutePage({ ids, cfi = '' }: ReaderRoutePageProps) {
  const _ = useTranslation();
  const { appService } = useEnv();
  const { settings } = useSettingsStore();

  useAppUrlIngress();
  useOpenWithBooks();
  useOpenAnnotationLink();
  useOpenShareLink();

  useEffect(() => {
    const doCheckAppUpdates = async () => {
      if (appService?.hasUpdater && settings.autoCheckUpdates) {
        await checkForAppUpdates(_);
      } else if (appService?.hasUpdater === false) {
        checkAppReleaseNotes();
      }
    };

    if (appService?.hasWindow && settings.alwaysOnTop) {
      tauriHandleSetAlwaysOnTop(settings.alwaysOnTop);
    }

    doCheckAppUpdates();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [appService?.hasUpdater, settings.autoCheckUpdates]);

  return <Reader ids={ids} cfi={cfi} />;
}
