import { createFileRoute, redirect } from '@tanstack/react-router';
import { legacyReaderSearchSchema } from './readerSearch';

export const Route = createFileRoute('/reader/')({
  validateSearch: legacyReaderSearchSchema,
  beforeLoad: ({ search }) => {
    if (search.ids) {
      throw redirect({
        to: `/reader/$ids`,
        params: {
          ids: search.ids,
        },
        search: search.cfi ? { cfi: search.cfi } : {},
        replace: true,
      });
    }

    throw redirect({
      to: '/library',
      replace: true,
    });
  },
  component: () => null,
});
