import { createFileRoute } from '@tanstack/react-router';
import { z } from 'zod';
import { UpdateEmail } from '@/components/settings/updateEmail';

const authUpdateSearchSchema = z.object({
  redirect: z.string().default('/library').catch('/library'),
});

export const Route = createFileRoute('/auth/update/')({
  validateSearch: authUpdateSearchSchema,
  component: UpdateEmail,
});

