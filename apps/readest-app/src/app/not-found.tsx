import { ArrowLeft, BookOpen, Compass } from 'lucide-react';
import { useTranslation } from '@/hooks/useTranslation';
import { StatusPage } from '@/components/status/StatusPage';

export function NotFoundPage() {
  const _ = useTranslation();

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
      badge={<Compass className='text-warning h-7 w-7' strokeWidth={1.8} />}
      eyebrow={_('404')}
      title={_('That page is not available')}
      description={_(
        'The address may be outdated, incomplete, or no longer part of the current app navigation.',
      )}
      actions={
        <>
          <button onClick={handleGoHome} className='btn btn-primary gap-2'>
            <BookOpen className='h-4 w-4' strokeWidth={1.8} />
            {_('Open Library')}
          </button>

          <button onClick={handleGoBack} className='btn btn-ghost eink-bordered gap-2'>
            <ArrowLeft className='h-4 w-4' strokeWidth={1.8} />
            {_('Go Back')}
          </button>
        </>
      }
      asideTitle={_('Where to go next')}
      asideBody={_(
        'If you were following an old link, the library is usually the quickest way back into your reading flow.',
      )}
      asideItems={[
        _('Return to your library to reopen a recent book or continue where you left off.'),
        _('Go back if you arrived here from a navigation action that can be retried.'),
        _('Check the address if you entered it manually or opened a stale bookmark.'),
      ]}
    />
  );
}
