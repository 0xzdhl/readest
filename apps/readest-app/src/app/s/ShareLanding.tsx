import { useEffect, useState, type ReactNode } from 'react';
import { useRouter, useLocation } from '@tanstack/react-router';
import {
  IoAlertCircleOutline,
  IoBookOutline,
  IoLibraryOutline,
  IoOpenOutline,
} from 'react-icons/io5';
import { getWebsiteUrl } from '@/services/environment';
import { useTranslation, type TranslationFunc } from '@/hooks/useTranslation';
import { useAuth } from '@/context/AuthContext';
import { useBooted } from '@/context/EffectRuntimeProvider';
import { PageFooter } from '@/components/landing/PageFooter';
import { getShare, importShare, type ShareMetadata } from '@/libs/share';
import { ensureSharedBookLocal } from '@/libs/shareImport';
import { formatBytes } from '@/utils/book';
import { navigateToReader } from '@/utils/nav';

const formatExpiry = (iso: string, _: TranslationFunc): string => {
  const ms = new Date(iso).getTime() - Date.now();
  const days = Math.round(ms / (24 * 60 * 60 * 1000));
  const hours = Math.round(ms / (60 * 60 * 1000));
  if (days >= 1) return _('Expires in {{count}} days', { count: days });
  if (hours > 0) return _('Expires in {{count}} hours', { count: hours });
  return _('Expiring soon');
};

const ShareLanding = () => {
  const _ = useTranslation();
  const router = useRouter();
  const { pathname, searchStr } = useLocation();
  const searchParams = new URLSearchParams(searchStr);
  const { user } = useAuth();
  const booted = useBooted();

  // Resolve the token from either the query fallback (?token=) or the pretty
  // path (/s/{token}). The pathname fallback still matters for static Tauri
  // builds and for direct visits before the router has hydrated.
  let token = searchParams.get('token') ?? '';
  if (!token && pathname) {
    const segments = pathname.split('/').filter(Boolean);
    if (segments[0] === 's' && segments[1]) {
      token = segments[1];
    }
  }

  const [meta, setMeta] = useState<ShareMetadata | null>(null);
  const [loadError, setLoadError] = useState<{ status: number; message: string } | null>(null);
  const [importing, setImporting] = useState(false);
  const [importProgress, setImportProgress] = useState<number | null>(null);
  const [importError, setImportError] = useState<string | null>(null);

  useEffect(() => {
    if (!token) {
      setLoadError({ status: 400, message: _('Missing share token') });
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const data = await getShare(token);
        if (!cancelled) setMeta(data);
      } catch (err) {
        if (!cancelled) {
          const status =
            err && typeof err === 'object' && 'status' in err && typeof err.status === 'number'
              ? err.status
              : 500;
          setLoadError({ status, message: err instanceof Error ? err.message : 'Unknown error' });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [token, _]);

  const appHref = `readest://share/${encodeURIComponent(token)}`;

  const handleAddToLibrary = async () => {
    if (!token || importing || !booted) return;
    setImporting(true);
    setImportProgress(null);
    setImportError(null);
    try {
      const result = await importShare(token);
      // /import only mutates server state (R2 byte-copy + files row). The
      // local library is unchanged, so the reader's getBookByHash would miss.
      // Pull bytes + create the local Book entry before navigating; meta is
      // already in state from the initial getShare call so no extra round-trip.
      await ensureSharedBookLocal({
        token,
        importResult: result,
        meta: meta ?? undefined,
        onProgress: setImportProgress,
      });
      // Reader URLs are canonicalized through TanStack Router as
      // /reader/{hash}?cfi=..., so navigation stays aligned with the actual
      // dynamic route instead of relying on a legacy query-only entrypoint.
      const queryParams = result.cfi ? `cfi=${encodeURIComponent(result.cfi)}` : undefined;
      navigateToReader(router, [result.bookHash], queryParams);
    } catch (err) {
      setImporting(false);
      setImportProgress(null);
      const message = err instanceof Error ? err.message : _('Could not add to your library');
      setImportError(message);
    }
  };

  // Shared page chrome: a full-height window-tier backdrop with a small
  // Readest brand mark anchored at the top and the footer pinned below. Every
  // state (error, loading, loaded) renders inside this same frame so the page
  // reads as one airy surface rather than a card floating in a void.
  const renderShell = (content: ReactNode) => (
    <main className='bg-base-200 flex min-h-[100dvh] flex-col px-5 py-8 sm:px-8 sm:py-12'>
      <header className='mx-auto flex w-full max-w-5xl items-center gap-2.5'>
        <img
          src='/icon.png'
          alt={_('Readest logo')}
          width={32}
          height={32}
          loading='lazy'
          className='rounded-lg'
        />
        <span className='text-base-content text-sm font-semibold'>{_('Shared with you')}</span>
      </header>
      <div className='mx-auto flex w-full max-w-5xl flex-1 flex-col items-center justify-center py-10'>
        {content}
      </div>
      <footer className='mx-auto w-full max-w-5xl'>
        <PageFooter tagline={_('Open-source ebook reader for everyone, on every device.')} />
      </footer>
    </main>
  );

  if (loadError) {
    // Pick a body copy that reflects the actual failure mode. Network /
    // unknown failures get the generic "try again" message; only confirmed
    // expired/revoked/not-found responses get the "no longer available" copy.
    // This makes misconfigurations debuggable without inspecting devtools.
    const isUnavailable = loadError.status === 410 || loadError.status === 404;
    const isInvalidToken = loadError.status === 400;
    const heading = isUnavailable
      ? _('This share link is no longer available')
      : isInvalidToken
        ? _("This link can't be opened")
        : _('Could not load shared book');
    const body = isUnavailable
      ? _('The original link may have expired or been revoked.')
      : isInvalidToken
        ? _('The share link is missing required information.')
        : _('Please check your connection and try again.');

    return renderShell(
      <div className='flex max-w-md flex-col items-center text-center'>
        <div className='border-base-300 bg-base-100 eink-bordered mb-5 flex h-16 w-16 items-center justify-center rounded-2xl border'>
          <IoAlertCircleOutline className='text-base-content h-8 w-8' aria-hidden='true' />
        </div>
        <h1 className='text-base-content text-2xl font-semibold tracking-tight'>{heading}</h1>
        <p className='text-base-content/70 mt-2.5 text-sm leading-relaxed'>{body}</p>
        <a
          href={getWebsiteUrl()}
          target='_blank'
          rel='noopener'
          className='btn btn-ghost mt-7 rounded-xl'
        >
          {_('Get Readest')}
        </a>
      </div>,
    );
  }

  if (!meta) {
    return renderShell(
      <div
        className='flex flex-col items-center gap-4 text-center'
        role='status'
        aria-live='polite'
      >
        <span className='loading loading-dots loading-md text-primary' aria-hidden='true' />
        <span className='text-base-content/70 text-sm'>{_('Loading shared book…')}</span>
      </div>,
    );
  }

  const coverSrc = meta.hasCover ? `/api/share/${encodeURIComponent(token)}/cover` : null;
  const expiryLabel = formatExpiry(meta.expiresAt, _);

  return renderShell(
    <div className='grid w-full items-center gap-10 lg:grid-cols-[auto_minmax(0,1fr)] lg:gap-16'>
      {/* Cover: the hero visual. The real book cover IS the imagery, shown at
          a generous size. aspect-[2/3] keeps the frame stable while the image
          fetches; eink-bordered keeps the frame visible on monochrome. */}
      <div className='flex justify-center lg:justify-self-end'>
        <div className='border-base-300 bg-base-100 eink-bordered aspect-[2/3] w-48 shrink-0 overflow-hidden rounded-xl border shadow-lg sm:w-56 lg:w-64'>
          {coverSrc ? (
            // Plain <img>: source is a presigned URL that varies per request,
            // so a static image loader gives no benefit.
            <img src={coverSrc} alt='' className='h-full w-full object-cover' loading='eager' />
          ) : (
            <div className='bg-base-200 flex h-full w-full items-center justify-center'>
              <IoBookOutline className='text-base-content/40 h-14 w-14' aria-hidden='true' />
            </div>
          )}
        </div>
      </div>

      {/* Content column: title, author, metadata, then the single accent CTA.
          Centered on mobile (under the cover); start-aligned on desktop. */}
      <div className='flex min-w-0 flex-col items-center text-center lg:items-start lg:text-start'>
        <h1 className='text-base-content line-clamp-4 text-3xl font-semibold leading-tight tracking-tight sm:text-4xl'>
          {meta.title}
        </h1>
        {meta.author && (
          <p className='text-base-content/70 mt-3 max-w-full truncate text-base'>{meta.author}</p>
        )}

        {/* Metadata chips: format, size, expiry. Bordered pills so they read
            with structure on e-ink, not color alone. */}
        <div className='mt-5 flex flex-wrap items-center justify-center gap-2 lg:justify-start'>
          <span className='border-base-300 text-base-content eink-bordered rounded-full border px-3 py-1 text-xs font-medium'>
            {meta.format.toUpperCase()}
          </span>
          <span className='border-base-300 text-base-content eink-bordered rounded-full border px-3 py-1 text-xs font-medium'>
            {formatBytes(meta.size)}
          </span>
          <span className='border-base-300 text-base-content eink-bordered rounded-full border px-3 py-1 text-xs font-medium'>
            {expiryLabel}
          </span>
        </div>

        {/* Direct file download is intentionally disabled on the landing page
            for now (rights / abuse risk). Recipients open the share inside the
            app — logged-in via "Add to my library", anonymous via the
            readest:// deep link with a "Get Readest" footnote fallback. The
            /api/share/$token/download route still exists so we can re-enable
            the button without a server change. */}
        <div className='mt-8 flex w-full max-w-sm flex-col gap-3 lg:max-w-md'>
          {user ? (
            <>
              <button
                type='button'
                onClick={handleAddToLibrary}
                disabled={importing}
                aria-busy={importing}
                className='btn btn-primary btn-block flex-nowrap gap-2 whitespace-nowrap rounded-xl'
              >
                {importing ? (
                  <span className='loading loading-spinner loading-sm' aria-hidden='true' />
                ) : (
                  <IoLibraryOutline className='h-5 w-5' aria-hidden='true' />
                )}
                {importing
                  ? importProgress !== null
                    ? _('Downloading… {{percent}}%', { percent: importProgress })
                    : _('Adding…')
                  : _('Add to my library')}
              </button>
              {/* Live progress bar while bytes are streaming in. Stays at the
                  indeterminate striped state until we get the first progress
                  event from the byte transfer. */}
              {importing && (
                <progress
                  className='progress progress-primary w-full'
                  value={importProgress ?? undefined}
                  max={100}
                  aria-label={_('Import progress')}
                />
              )}
              <a
                href={appHref}
                aria-disabled={importing}
                onClick={(e) => {
                  if (importing) e.preventDefault();
                }}
                className={
                  importing
                    ? 'btn btn-ghost btn-block btn-disabled flex-nowrap gap-2 whitespace-nowrap rounded-xl'
                    : 'btn btn-ghost btn-block flex-nowrap gap-2 whitespace-nowrap rounded-xl'
                }
              >
                <IoOpenOutline className='h-5 w-5' aria-hidden='true' />
                {_('Open in app')}
              </a>
              {importError && (
                <p className='text-error text-center text-xs lg:text-start' role='alert'>
                  {importError}
                </p>
              )}
            </>
          ) : (
            <>
              <a
                href={appHref}
                className='btn btn-primary btn-block flex-nowrap gap-2 whitespace-nowrap rounded-xl'
              >
                <IoOpenOutline className='h-5 w-5' aria-hidden='true' />
                {_('Open in app')}
              </a>
              <p className='text-base-content/60 text-center text-xs lg:text-start'>
                {_("Don't have Readest?")}{' '}
                <a
                  href={getWebsiteUrl()}
                  target='_blank'
                  rel='noopener'
                  className='text-primary font-medium hover:underline'
                >
                  {_('Download Readest')}
                </a>
              </p>
            </>
          )}
        </div>
      </div>
    </div>,
  );
};

export default ShareLanding;
