import { useEffect, useState } from 'react';
import { useRouter, useLocation } from '@tanstack/react-router';
import { IoAlertCircleOutline, IoBookOutline, IoOpenOutline } from 'react-icons/io5';
import { getWebsiteUrl, getBaseUrl } from '@/services/environment';
import { useTranslation } from '@/hooks/useTranslation';
import { buildAnnotationAppUrl } from '@/utils/deeplink';
import { PageFooter } from '@/components/landing/PageFooter';

type Platform = 'android-chromium' | 'android-other' | 'ios' | 'desktop' | 'unknown';

const detectPlatform = (): Platform => {
  if (typeof navigator === 'undefined') return 'unknown';
  const ua = navigator.userAgent;
  const isAndroid = /Android/i.test(ua);
  const isIOS = /iPad|iPhone|iPod/.test(ua) && !('MSStream' in window);
  if (isAndroid) {
    const isChromium = /Chrome|CriOS|EdgA|Brave/i.test(ua) && !/Firefox|FxiOS/i.test(ua);
    return isChromium ? 'android-chromium' : 'android-other';
  }
  if (isIOS) return 'ios';
  return 'desktop';
};

const ANDROID_PACKAGE = 'com.bilingify.readest';
const FALLBACK_TIMEOUT_MS = 1500;
const DESKTOP_FALLBACK_DELAY_MS = 1000;

const buildIntentUrl = (path: string, fallbackUrl: string) => {
  const cleanPath = path.replace(/^\//, '');
  return `intent://${cleanPath}#Intent;scheme=readest;package=${ANDROID_PACKAGE};S.browser_fallback_url=${encodeURIComponent(fallbackUrl)};end`;
};

const buildWebReaderUrl = (bookHash: string, cfi: string | null): string => {
  const query = cfi ? `?${new URLSearchParams({ cfi }).toString()}` : '';
  return `/reader/${bookHash}${query}`;
};

export function OpenAnnotationPage() {
  const _ = useTranslation();
  const router = useRouter();
  const { pathname, searchStr } = useLocation();
  const searchParams = new URLSearchParams(searchStr);
  const [showManualOpen, setShowManualOpen] = useState(false);

  let bookHash = searchParams.get('book') ?? null;
  let noteId = searchParams.get('note') ?? null;
  if ((!bookHash || !noteId) && pathname) {
    const segments = pathname.split('/').filter(Boolean);
    if (segments[0] === 'o' && segments[1] === 'book' && segments[3] === 'annotation') {
      bookHash = segments[2] ?? null;
      noteId = segments[4] ?? null;
    }
  }
  const cfi = searchParams.get('cfi') ?? null;

  useEffect(() => {
    if (!bookHash || !noteId) return;
    const platform = detectPlatform();
    const appUrl = buildAnnotationAppUrl({ bookHash, noteId, cfi: cfi ?? undefined });
    const webReaderUrl = buildWebReaderUrl(bookHash, cfi);
    const path = `book/${bookHash}/annotation/${noteId}${cfi ? `?cfi=${encodeURIComponent(cfi)}` : ''}`;

    if (platform === 'android-chromium') {
      const absoluteFallback = `${getBaseUrl()}${webReaderUrl}`;
      window.location.replace(buildIntentUrl(path, absoluteFallback));
      return;
    }

    if (platform === 'android-other') {
      let cancelled = false;
      const onVisibility = () => {
        if (document.visibilityState === 'hidden') cancelled = true;
      };
      document.addEventListener('visibilitychange', onVisibility);
      window.location.replace(appUrl);
      const timer = window.setTimeout(() => {
        document.removeEventListener('visibilitychange', onVisibility);
        if (!cancelled) router.navigate({ to: webReaderUrl });
      }, FALLBACK_TIMEOUT_MS);
      return () => {
        document.removeEventListener('visibilitychange', onVisibility);
        window.clearTimeout(timer);
      };
    }

    if (platform === 'ios') {
      setShowManualOpen(true);
      return;
    }

    window.location.href = appUrl;
    const desktopTimer = window.setTimeout(() => {
      setShowManualOpen(true);
    }, DESKTOP_FALLBACK_DELAY_MS);
    return () => {
      window.clearTimeout(desktopTimer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bookHash, noteId, cfi]);

  if (!bookHash || !noteId) {
    return (
      <main className='bg-base-200 flex min-h-[100dvh] flex-col items-center justify-center p-6 sm:p-10'>
        <div className='flex w-full max-w-sm flex-col items-center text-center'>
          <span
            className='eink-bordered border-base-300 bg-base-100 mb-6 flex h-16 w-16 items-center justify-center rounded-full border'
            aria-hidden='true'
          >
            <IoAlertCircleOutline className='text-base-content h-8 w-8' />
          </span>
          <h1 className='text-base-content text-2xl font-semibold tracking-tight'>
            {_("This link can't be opened")}
          </h1>
          <p className='text-base-content/70 mt-3 text-sm leading-relaxed'>
            {_(
              'The annotation link is missing required information. The original link may have been truncated.',
            )}
          </p>
          <a href={getWebsiteUrl()} className='btn btn-primary btn-block mt-8' rel='noopener'>
            {_('Go to Readest')}
          </a>
        </div>
        <div className='mt-10'>
          <PageFooter tagline={_('Open-source ebook reader for everyone, on every device.')} />
        </div>
      </main>
    );
  }

  const appUrl = buildAnnotationAppUrl({ bookHash, noteId, cfi: cfi ?? undefined });
  const webReaderHref = buildWebReaderUrl(bookHash, cfi);

  return (
    <main className='bg-base-200 flex min-h-[100dvh] flex-col items-center justify-center p-6 sm:p-10'>
      <div className='flex w-full max-w-sm flex-col items-center text-center'>
        <img
          src='/icon.png'
          alt={_('Readest logo')}
          width={64}
          height={64}
          loading='lazy'
          className='mb-6 rounded-2xl'
        />
        <h1 className='text-base-content text-2xl font-semibold tracking-tight'>
          {_('Open in Readest')}
        </h1>
        <p className='text-base-content/70 mt-3 text-sm leading-relaxed'>
          {showManualOpen
            ? _("If Readest didn't open automatically, choose an option below:")
            : _('Continue reading where you left off.')}
        </p>

        {!showManualOpen && (
          <div className='mt-8 flex flex-col items-center gap-3' role='status' aria-live='polite'>
            <span className='loading loading-dots loading-md text-primary' aria-hidden='true' />
            <span className='text-base-content/70 text-sm'>{_('Opening Readest...')}</span>
          </div>
        )}

        <div
          className={`flex w-full flex-col gap-2 transition-opacity motion-safe:duration-200 ${
            showManualOpen
              ? 'mt-8 opacity-100'
              : 'pointer-events-none h-0 overflow-hidden opacity-0'
          }`}
        >
          <a href={appUrl} className='btn btn-primary btn-block' rel='noopener'>
            <IoBookOutline className='h-5 w-5' aria-hidden='true' />
            {_('Open in Readest app')}
          </a>
          <a href={webReaderHref} className='btn btn-ghost btn-block' rel='noopener'>
            <IoOpenOutline className='h-5 w-5' aria-hidden='true' />
            {_('Continue in browser')}
          </a>
          <p className='text-base-content/60 mt-3 text-center text-xs'>
            {_("Don't have Readest?")}{' '}
            <a
              href={getWebsiteUrl()}
              target='_blank'
              rel='noopener'
              className='text-primary font-medium hover:underline'
            >
              {_('Download')}
            </a>
          </p>
        </div>
      </div>
      <div className='mt-10'>
        <PageFooter tagline={_('Open-source ebook reader for everyone, on every device.')} />
      </div>
    </main>
  );
}
