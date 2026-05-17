import { createFileRoute } from '@tanstack/react-router';
import { createSupabaseAdminClient } from '@/utils/supabase';
import { validateUserAndToken } from '@/utils/access';

export const Route = createFileRoute('/api/user/delete')({
  server: {
    handlers: {
      DELETE: async ({ request }) => {
        try {
          const { user, token } = await validateUserAndToken(
            request.headers.get('authorization') ?? undefined,
          );
          if (!user || !token) {
            return Response.json({ error: 'Not authenticated' }, { status: 403 });
          }

          const supabaseAdmin = createSupabaseAdminClient();
          const { error } = await supabaseAdmin.auth.admin.deleteUser(user.id);
          if (error) {
            return Response.json({ error: error.message }, { status: 500 });
          }

          return Response.json({ message: 'User deleted successfully' });
        } catch (error) {
          console.error(error);
          return Response.json({ error: 'Something went wrong' }, { status: 500 });
        }
      },
    },
  },
});
