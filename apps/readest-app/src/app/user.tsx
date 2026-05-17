import { createFileRoute, Outlet } from '@tanstack/react-router';

export const Route = createFileRoute('/user')({
  head: () => ({
    meta: [
      { title: 'Account & Sign In' },
      {
        name: 'description',
        content:
          'Sign in to your Readest account or manage your subscription, cloud library storage, and account settings.',
      },
    ],
  }),
  component: ProfileLayout,
});

function ProfileLayout() {
  return <Outlet />;
}
