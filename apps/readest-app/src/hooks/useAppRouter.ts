import { useRouter } from '@tanstack/react-router';

export const useAppRouter = () => {
  const router = useRouter();
  return router;
};
