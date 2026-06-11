import { createFileRoute } from '@tanstack/react-router';
import { SharePage } from './SharePage';
import { buildShareHead, loadSharePage } from './shareRoute';

// Path-based share route: the canonical share URL is `${base}/s/{token}` (see
// buildShareUrl / getShareBaseUrl). The token rides in the path, so the loader
// reads it from params — the sibling `/s/` index route's `?token=` search param
// is only a legacy fallback. Without this route, `/s/{token}` matches nothing
// and falls through to not-found ("That page is not available").
export const Route = createFileRoute('/s/$token')({
  loader: async ({ params }) => loadSharePage(params.token),
  head: ({ loaderData }) => buildShareHead(loaderData),
  component: SharePage,
});
