import { useRouter } from '@tanstack/react-router';
import { useEnv } from '@/context/EnvContext';

export const useAppRouter = () => {
  const { appService } = useEnv();
  const router = useRouter();
  return router;
};
