import { createClient } from '@supabase/supabase-js';
import { readPublicEnv } from '@/utils/publicEnv';

const tryDecodeBase64 = (value: string | undefined) => {
  if (!value) return undefined;
  try {
    return atob(value);
  } catch {
    return undefined;
  }
};

const supabaseUrl =
  process.env['SUPABASE_URL'] ||
  readPublicEnv('VITE_SUPABASE_URL') ||
  tryDecodeBase64(readPublicEnv('VITE_DEFAULT_SUPABASE_URL_BASE64'));
const supabaseAnonKey =
  process.env['SUPABASE_ANON_KEY'] ||
  readPublicEnv('VITE_SUPABASE_ANON_KEY') ||
  tryDecodeBase64(readPublicEnv('VITE_DEFAULT_SUPABASE_KEY_BASE64'));

const hasSupabaseConfig = !!supabaseUrl && !!supabaseAnonKey;

if (!hasSupabaseConfig && typeof window !== 'undefined') {
  console.warn(
    'Supabase config is missing. Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY for local web development.',
  );
}

const fallbackSupabaseUrl = 'http://127.0.0.1:54321';
const fallbackSupabaseAnonKey = 'public-anon-key-placeholder';

export const supabase = createClient(
  supabaseUrl || fallbackSupabaseUrl,
  supabaseAnonKey || fallbackSupabaseAnonKey,
);

export const createSupabaseClient = (accessToken?: string) => {
  return createClient(
    supabaseUrl || fallbackSupabaseUrl,
    supabaseAnonKey || fallbackSupabaseAnonKey,
    {
      global: {
        headers: accessToken
          ? {
              Authorization: `Bearer ${accessToken}`,
            }
          : {},
      },
    },
  );
};

export const createSupabaseAdminClient = () => {
  const supabaseAdminKey = process.env['SUPABASE_ADMIN_KEY'] || '';
  return createClient(supabaseUrl || fallbackSupabaseUrl, supabaseAdminKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
  });
};
