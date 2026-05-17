import { createFileRoute } from '@tanstack/react-router';
import { z } from 'zod';
import { SharePage } from './SharePage';
import { buildShareHead, loadSharePage } from './shareRoute';

const shareSearchSchema = z.object({
  token: z.string().default('').catch(''),
});

export const Route = createFileRoute('/s/')({
  validateSearch: shareSearchSchema,
  loaderDeps: ({ search }) => ({ token: search.token }),
  loader: async ({ deps }) => loadSharePage(deps.token),
  head: ({ loaderData }) => buildShareHead(loaderData),
  component: SharePage,
});
