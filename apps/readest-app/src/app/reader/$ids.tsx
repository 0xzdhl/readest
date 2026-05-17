import { createFileRoute } from '@tanstack/react-router';
import { ReaderRoutePage } from './ReaderRoutePage';
import { readerSearchSchema } from './readerSearch';

export const Route = createFileRoute('/reader/$ids')({
  validateSearch: readerSearchSchema,
  component: ReaderIdsPage,
});

function ReaderIdsPage() {
  const { ids } = Route.useParams();
  const { cfi } = Route.useSearch();

  return <ReaderRoutePage ids={ids} cfi={cfi} />;
}
