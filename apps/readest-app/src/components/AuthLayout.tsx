import type React from 'react';
import { useTranslation } from '@/hooks/useTranslation';

interface AuthLayoutProps {
  /** Optional content rendered above the layout (e.g. a back button /
   * window-chrome row). Rendered as a fixed-position overlay so the caller
   * stays responsible for safe-area / traffic-light spacing. */
  chrome?: React.ReactNode;
  /** The form column content. */
  children: React.ReactNode;
}

/**
 * Shared split-screen shell for the auth-family screens (sign-in / sign-up /
 * forgot, reset-password, change-email). Purely presentational; carries no
 * auth logic and just slots the caller's form into the form column.
 *
 * Desktop (>= lg): two columns filling the viewport — a generous brand rail on
 * the start edge, the form centered on the end. Mobile: a single top-aligned
 * column where a compact brand block sits directly above the form (one unit,
 * no large blank above the inputs).
 *
 * E-ink: the brand rail is separated from the form with an `eink-bordered`
 * logical-end border so the split reads with no color or shadow.
 */
export const AuthLayout: React.FC<AuthLayoutProps> = ({ chrome, children }) => {
  const _ = useTranslation();
  const valueLine = _('Read everywhere. Your books, notes, and progress stay in sync.');
  return (
    <div className='bg-base-100 flex min-h-[100dvh] w-full flex-col lg:flex-row'>
      {chrome}
      {/* Desktop brand rail (hidden on mobile — mobile gets the compact block
          inside the form column below so the brand travels WITH the form). */}
      <aside className='bg-base-200 eink-bordered border-base-200 hidden flex-col justify-center px-12 py-16 lg:flex lg:w-[42%] lg:border-e'>
        <div className='flex flex-col items-start gap-6 text-start'>
          <img src='/icon.png' alt={_('Readen')} width={76} height={76} className='rounded-2xl' />
          <div className='flex flex-col gap-3'>
            <span className='text-base-content text-4xl font-semibold tracking-tight'>
              {_('Readen')}
            </span>
            <p className='text-base-content/70 max-w-sm text-lg leading-relaxed'>{valueLine}</p>
          </div>
        </div>
      </aside>
      {/* Form column. Top-aligned on mobile (no vertical-centering blank above
          the inputs); vertically centered only on desktop. */}
      <main className='flex flex-1 flex-col px-6 pb-10 pt-12 lg:items-center lg:justify-center lg:px-12 lg:py-10'>
        <div className='mx-auto flex w-full max-w-sm flex-col'>
          {/* Mobile-only compact brand, integrated directly above the form. */}
          <div className='mb-8 flex flex-col items-center gap-3 text-center lg:hidden'>
            <img src='/icon.png' alt={_('Readen')} width={56} height={56} className='rounded-2xl' />
            <div className='flex flex-col gap-1.5'>
              <span className='text-base-content text-2xl font-semibold tracking-tight'>
                {_('Readen')}
              </span>
              <p className='text-base-content/70 text-[0.95em] leading-relaxed'>{valueLine}</p>
            </div>
          </div>
          {children}
        </div>
      </main>
    </div>
  );
};

export default AuthLayout;
