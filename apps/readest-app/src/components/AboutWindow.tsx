import clsx from 'clsx';
import { useEffect, useState } from 'react';
import { MdOutlineOpenInNew } from 'react-icons/md';
import { FaGithub } from 'react-icons/fa';
import { usePlatformInfo } from '@/context/EffectRuntimeProvider';
import { useTranslation } from '@/hooks/useTranslation';
import { checkForAppUpdates, checkAppReleaseNotes } from '@/helpers/updater';
import { parseWebViewInfo } from '@/utils/ua';
import { getAppVersion } from '@/utils/version';
import { getBrandName } from '@/services/environment';
import { BoxedList, SectionTitle } from '@/components/settings/primitives';
import SupportLinks from './SupportLinks';
import LegalLinks from './LegalLinks';
import Dialog from './Dialog';
import Link from './Link';

export const setAboutDialogVisible = (visible: boolean) => {
  const dialog = document.getElementById('about_window');
  if (dialog) {
    const event = new CustomEvent('setDialogVisibility', {
      detail: { visible },
    });
    dialog.dispatchEvent(event);
  }
};

type UpdateStatus = 'checking' | 'updating' | 'updated' | 'error';

export const AboutWindow = () => {
  const _ = useTranslation();
  const platformInfo = usePlatformInfo();
  const [updateStatus, setUpdateStatus] = useState<UpdateStatus | null>(null);
  const [browserInfo, setBrowserInfo] = useState('');
  const [isOpen, setIsOpen] = useState(false);

  useEffect(() => {
    setBrowserInfo(parseWebViewInfo(platformInfo));

    const handleCustomEvent = (event: CustomEvent) => {
      setIsOpen(event.detail.visible);
    };

    const el = document.getElementById('about_window');
    if (el) {
      el.addEventListener('setDialogVisibility', handleCustomEvent as EventListener);
    }

    return () => {
      if (el) {
        el.removeEventListener('setDialogVisibility', handleCustomEvent as EventListener);
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleCheckUpdate = async () => {
    setUpdateStatus('checking');
    try {
      const hasUpdate = await checkForAppUpdates(_, false);
      if (hasUpdate) {
        handleClose();
      } else {
        setUpdateStatus('updated');
      }
    } catch (error) {
      console.info('Error checking for updates:', error);
      setUpdateStatus('error');
    }
  };

  const handleShowRecentUpdates = async () => {
    const hasNotes = await checkAppReleaseNotes(false);
    if (hasNotes) {
      handleClose();
    } else {
      setUpdateStatus('error');
    }
  };

  const handleClose = () => {
    setIsOpen(false);
    setUpdateStatus(null);
  };

  return (
    <Dialog
      id='about_window'
      isOpen={isOpen}
      title={_('About Readest')}
      onClose={handleClose}
      boxClassName='sm:!w-[480px] sm:!max-w-screen-sm sm:h-auto'
    >
      {isOpen && (
        <div className='about-content flex flex-col items-center gap-8 pb-10 pt-2 sm:pb-4'>
          {/* Identity: logo, brand name, version */}
          <div className='flex flex-col items-center gap-3 text-center'>
            <img
              src='/icon.png'
              alt={getBrandName()}
              className='eink-bordered border-base-200 h-20 w-20 rounded-2xl border'
              width={64}
              height={64}
              loading='lazy'
            />
            <div className='flex select-text flex-col items-center gap-1'>
              <h2 className='text-base-content text-2xl font-bold tracking-tight'>
                {getBrandName()}
              </h2>
              <p className='text-base-content/60 text-[0.85em]'>
                {_('Version {{version}}', { version: getAppVersion() })} {`(${browserInfo})`}
              </p>
            </div>

            {/* Update check: single primary CTA + status states */}
            <div className='mt-1 flex min-h-9 items-center justify-center'>
              {!updateStatus && (
                <button
                  type='button'
                  className='btn btn-primary btn-sm'
                  onClick={platformInfo.hasUpdater ? handleCheckUpdate : handleShowRecentUpdates}
                >
                  {_('Check Update')}
                </button>
              )}
              {updateStatus === 'checking' && (
                <p className='text-base-content/60 inline-flex items-center gap-2 text-[0.85em]'>
                  <span className='loading loading-spinner loading-xs' aria-hidden='true' />
                  {_('Checking for updates...')}
                </p>
              )}
              {updateStatus === 'updated' && (
                <p className='text-success text-[0.85em]'>{_('Already the latest version')}</p>
              )}
              {updateStatus === 'error' && (
                <p className='text-error text-[0.85em]'>{_('Error checking for updates')}</p>
              )}
            </div>
          </div>

          {/* Resources: on-system link rows */}
          <BoxedList title={_('Resources')} className='select-none'>
            <AboutLinkRow
              icon={FaGithub}
              href='https://github.com/readest/readest'
              label={_('Source Code on GitHub')}
            />
            <AboutLinkRow
              href='https://www.gnu.org/licenses/agpl-3.0.html'
              label={_('GNU Affero General Public License v3.0')}
            />
          </BoxedList>

          {/* Legal + community: preserved existing components */}
          <div className='flex w-full flex-col items-center gap-3'>
            <SectionTitle as='div' className='self-start'>
              {_('Legal')}
            </SectionTitle>
            <LegalLinks />
            <SupportLinks />
          </div>

          {/* Copyright */}
          <p className='text-base-content/50 text-center text-[0.8em]'>
            © {new Date().getFullYear()} Bilingify LLC. {_('All rights reserved.')}
          </p>
        </div>
      )}
    </Dialog>
  );
};

interface AboutLinkRowProps {
  href: string;
  label: string;
  icon?: React.ElementType;
}

/**
 * NavigationRow-style link row (ActionRow variant): leading icon chip · label ·
 * trailing open-in-new glyph. Uses the shared `<Link>` so the Tauri `openUrl`
 * vs. web `target=_blank` open mechanism is preserved exactly.
 */
const AboutLinkRow: React.FC<AboutLinkRowProps> = ({ href, label, icon: Icon }) => {
  return (
    <Link
      href={href}
      className={clsx(
        'group flex w-full items-center gap-3 py-4 pe-4 text-start',
        'transition-colors duration-150',
        'focus-visible:ring-base-content/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset',
      )}
    >
      {Icon && (
        <span className='bg-base-200 text-base-content/70 group-hover:bg-base-300/70 flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-full transition-colors duration-150'>
          <Icon className='h-5 w-5' />
        </span>
      )}
      <span className='text-base-content line-clamp-2 min-w-0 flex-1 font-medium'>{label}</span>
      <MdOutlineOpenInNew className='text-base-content/50 h-4 w-4 flex-shrink-0' />
    </Link>
  );
};
