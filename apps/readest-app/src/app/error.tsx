import posthog from 'posthog-js';
import { useEffect, useState } from 'react';
import { ArrowLeft, House, LifeBuoy, RefreshCw, TriangleAlert } from 'lucide-react';
import { createFileRoute, useRouter } from '@tanstack/react-router';
import { useEnv } from '@/context/EnvContext';
import { useTranslation } from '@/hooks/useTranslation';
import { StatusPage } from '@/components/status/StatusPage';
import { parseWebViewInfo } from '@/utils/ua';
import { handleGlobalError } from '@/utils/error';

// TanStack Router error component props — compatible with createFileRoute errorComponent
export interface ErrorComponentProps {
  error: Error & { digest?: string };
  reset: () => void;
  info?: { componentStack: string };
}

export const Route = createFileRoute('/error')({
  errorComponent: ErrorPageComponent,
  component: ErrorPageComponent,
});

function ErrorPageComponent() {
  // This is a standalone error page. When used as a route, the error state
  // is managed by the router. Direct navigation shows the generic error UI.
  return (
    <ErrorPageUI
      error={new Error('An unexpected error occurred')}
      reset={() => window.location.reload()}
    />
  );
}

export function DefaultRouterErrorComponent(props: ErrorComponentProps) {
  const router = useRouter();

  return (
    <ErrorPageUI
      {...props}
      reset={() => {
        void router.invalidate();
        props.reset();
      }}
    />
  );
}

export function ErrorPageUI({ error, reset, info: _info }: ErrorComponentProps) {
  const _ = useTranslation();
  const { appService } = useEnv();
  const [browserInfo, setBrowserInfo] = useState('');

  useEffect(() => {
    setBrowserInfo(parseWebViewInfo(appService));
  }, [appService]);

  useEffect(() => {
    posthog.captureException(error);
    handleGlobalError(error);
  }, [appService, error]);

  const handleGoHome = () => {
    window.location.href = '/library';
  };

  const handleGoBack = () => {
    if (window.history.length > 1) {
      window.history.back();
    } else {
      handleGoHome();
    }
  };

  return (
    <StatusPage
      badge={<TriangleAlert className='text-error h-7 w-7' strokeWidth={1.8} />}
      eyebrow={_('Unexpected error')}
      title={_('This view could not be loaded')}
      description={_(
        'Readest hit a runtime error while opening this screen. You can retry now or return to your library.',
      )}
      details={
        <div className='space-y-4'>
          <div className='space-y-1.5'>
            <h3 className='text-base-content text-sm font-semibold'>{_('Error details')}</h3>
            <div className='eink-bordered bg-base-100/70 border-base-200 max-h-36 overflow-y-auto rounded-xl border px-3 py-2.5'>
              <p className='text-base-content/75 break-words font-mono text-sm leading-6'>
                {error.message}
              </p>
            </div>
          </div>

          {browserInfo || error.stack || error.digest ? (
            <div className='border-base-300/80 grid gap-3 border-t pt-4 text-sm'>
              {browserInfo ? (
                <div className='grid gap-1 sm:grid-cols-[7rem_minmax(0,1fr)] sm:gap-3'>
                  <span className='text-base-content/55 font-medium'>{_('Browser')}</span>
                  <span className='text-base-content/75 min-w-0 break-words font-mono'>
                    {browserInfo}
                  </span>
                </div>
              ) : null}

              {error.digest ? (
                <div className='grid gap-1 sm:grid-cols-[7rem_minmax(0,1fr)] sm:gap-3'>
                  <span className='text-base-content/55 font-medium'>{_('Error ID')}</span>
                  <span className='text-base-content/75 min-w-0 break-words font-mono'>
                    {error.digest}
                  </span>
                </div>
              ) : null}

              {error.stack ? (
                <div className='grid gap-1 sm:grid-cols-[7rem_minmax(0,1fr)] sm:gap-3'>
                  <span className='text-base-content/55 font-medium'>{_('Trace')}</span>
                  <div className='eink-bordered bg-base-100/70 border-base-200 min-w-0 rounded-xl border'>
                    <pre className='text-base-content/65 max-h-56 overflow-auto whitespace-pre-wrap break-words px-3 py-2.5 font-mono text-xs leading-6'>
                      {error.stack}
                    </pre>
                  </div>
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
      }
      actions={
        <>
          <button onClick={reset} className='btn btn-primary gap-2'>
            <RefreshCw className='h-4 w-4' strokeWidth={1.8} />
            {_('Try Again')}
          </button>

          <button onClick={handleGoBack} className='btn btn-ghost eink-bordered gap-2'>
            <ArrowLeft className='h-4 w-4' strokeWidth={1.8} />
            {_('Go Back')}
          </button>

          <button onClick={handleGoHome} className='btn btn-ghost eink-bordered gap-2'>
            <House className='h-4 w-4' strokeWidth={1.8} />
            {_('Your Library')}
          </button>
        </>
      }
      asideTitle={_('What you can do')}
      asideBody={_(
        'Start with a retry. If the issue keeps happening, return to the library and reopen the book or contact support.',
      )}
      asideItems={[
        _('Retry this screen to rerun the failed route loader or component render.'),
        _(
          'Go back if you were navigating from another page and want to keep your current session.',
        ),
        _('Return to your library to reopen the book from a stable entry point.'),
      ]}
      footer={
        <div className='flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between'>
          <p className='text-base-content/60 text-sm leading-6'>
            {_('Need help with a persistent crash? Include the error details when reporting it.')}
          </p>
          <a
            href='mailto:support@readest.com'
            className='btn btn-ghost eink-bordered gap-2 self-start'
          >
            <LifeBuoy className='h-4 w-4' strokeWidth={1.8} />
            {_('Contact Support')}
          </a>
        </div>
      }
    />
  );
}
