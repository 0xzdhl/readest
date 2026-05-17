import type { ReactNode } from 'react';

interface StatusPageProps {
  badge: ReactNode;
  eyebrow: string;
  title: string;
  description: string;
  details?: ReactNode;
  actions: ReactNode;
  asideTitle: string;
  asideBody: string;
  asideItems?: string[];
  footer?: ReactNode;
}

export function StatusPage({
  badge,
  eyebrow,
  title,
  description,
  details,
  actions,
  asideTitle,
  asideBody,
  asideItems,
  footer,
}: StatusPageProps) {
  return (
    <div className='bg-base-200 min-h-screen'>
      <div className='mx-auto flex min-h-screen w-full max-w-6xl items-center justify-center px-4 py-10 sm:px-6 lg:px-8'>
        <div className='grid w-full max-w-5xl gap-4 lg:grid-cols-[minmax(0,1.35fr)_minmax(18rem,0.65fr)] lg:items-stretch'>
          <section className='eink-bordered border-base-200 bg-base-100 rounded-3xl border p-6 sm:p-8 lg:p-10'>
            <div className='mb-8 flex items-start justify-between gap-4'>
              <div className='space-y-3'>
                <div className='text-base-content/55 text-xs font-semibold uppercase tracking-[0.24em]'>
                  {eyebrow}
                </div>
                <div className='space-y-2'>
                  <h1 className='text-base-content text-3xl font-semibold tracking-tight sm:text-4xl'>
                    {title}
                  </h1>
                  <p className='text-base-content/70 max-w-2xl text-sm leading-7 sm:text-base'>
                    {description}
                  </p>
                </div>
              </div>

              <div className='eink-bordered bg-base-200/80 text-base-content border-base-200 flex h-16 w-16 shrink-0 items-center justify-center rounded-2xl border'>
                {badge}
              </div>
            </div>

            {details ? (
              <div className='eink-bordered border-base-200 bg-base-200/45 mb-8 rounded-2xl border p-4 sm:p-5'>
                {details}
              </div>
            ) : null}

            <div className='flex flex-col gap-3 sm:flex-row sm:flex-wrap'>{actions}</div>

            {footer ? <div className='border-base-300 mt-8 border-t pt-5'>{footer}</div> : null}
          </section>

          <aside className='eink-bordered border-base-200 bg-base-100/80 rounded-3xl border p-6 sm:p-7'>
            <div className='space-y-3'>
              <h2 className='text-base-content text-lg font-semibold tracking-tight'>
                {asideTitle}
              </h2>
              <p className='text-base-content/70 text-sm leading-7'>{asideBody}</p>
            </div>

            {asideItems?.length ? (
              <div className='mt-6 space-y-3'>
                {asideItems.map((item) => (
                  <div
                    key={item}
                    className='eink-bordered bg-base-200/35 text-base-content/80 border-base-200 rounded-2xl border px-4 py-3 text-sm leading-6'
                  >
                    {item}
                  </div>
                ))}
              </div>
            ) : null}
          </aside>
        </div>
      </div>
    </div>
  );
}
