import { createFileRoute } from '@tanstack/react-router';
import { z } from 'zod';
import { OpenAnnotationPage } from './OpenAnnotationPage';

const openAnnotationSearchSchema = z.object({
  book: z.string().default('').catch(''),
  note: z.string().default('').catch(''),
  cfi: z.string().default('').catch(''),
});

export const Route = createFileRoute('/o/')({
  validateSearch: openAnnotationSearchSchema,
  component: OpenAnnotationPage,
});
