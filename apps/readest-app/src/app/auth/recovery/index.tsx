import { createFileRoute } from '@tanstack/react-router';
import { z } from 'zod';
import { ResetPassword } from '@/components/settings/ResetPassword';

const authRecoverySearchSchema = z.object({
  redirect: z.string().default('/library').catch('/library'),
});

export const Route = createFileRoute('/auth/recovery/')({
  validateSearch: authRecoverySearchSchema,
  component: ResetPassword,
});