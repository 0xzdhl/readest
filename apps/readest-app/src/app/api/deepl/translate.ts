import crypto from 'node:crypto';
import { createFileRoute } from '@tanstack/react-router';
import { env as appEnv } from '@/env';

// TODO: use t3-env
async function getCloudflareContext(): Promise<{ env: Record<string, unknown> }> {
  try {
    const workersModule = await import(/* @vite-ignore */ 'cloudflare:workers');
    return { env: workersModule.env as unknown as Record<string, unknown> };
  } catch {
    throw new Error('Cloudflare context not available');
  }
}

import { runAuth } from '@/libs/server/route-helpers';
import { ErrorCodes } from '@/services/translators';
import { getDailyTranslationPlanData, getSubscriptionPlan } from '@/utils/access';

interface KVNamespace {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
  delete(key: string): Promise<void>;
}

interface CloudflareEnv {
  TRANSLATIONS_KV?: KVNamespace;
}

const LANG_V2_V1_MAP: Record<string, string> = {
  'ZH-HANS': 'ZH',
  'ZH-HANT': 'ZH-TW',
};

const getDeepLAPIKey = (keys: string | undefined) => {
  const keyArray = keys?.split(',') ?? [];
  return keyArray.length ? keyArray[Math.floor(Math.random() * keyArray.length)]! : '';
};

const generateCacheKey = (text: string, sourceLang: string, targetLang: string): string => {
  const inputString = `${sourceLang}:${targetLang}:${text}`;
  const hash = crypto.createHash('sha1').update(inputString).digest('hex');
  return `tr:${hash}`;
};

async function callDeepLAPI(
  text: string,
  sourceLang: string,
  targetLang: string,
  apiUrl: string,
  authKey: string,
  translationsKV: KVNamespace | undefined,
  useCache: boolean,
) {
  const isV2Api = apiUrl.endsWith('/v2/translate');

  // TODO: this should be processed in the client, but for now, we need to do it here
  // please remove this when most clients are updated
  const input = text.replaceAll('\n', '').trim();

  const requestBody: {
    text: string | string[];
    target_lang: string;
    source_lang?: string;
  } = {
    text: isV2Api ? [input] : input,
    source_lang: isV2Api ? sourceLang : (LANG_V2_V1_MAP[sourceLang] ?? sourceLang),
    target_lang: isV2Api ? targetLang : (LANG_V2_V1_MAP[targetLang] ?? targetLang),
  };

  if (isV2Api && requestBody.source_lang?.toUpperCase() === 'AUTO') {
    delete requestBody.source_lang;
  }

  const response = await fetch(apiUrl, {
    method: 'POST',
    headers: {
      Authorization: `DeepL-Auth-Key ${authKey}`,
      'x-fingerprint': appEnv.DEEPL_X_FINGERPRINT,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(requestBody),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`DeepL API error (${response.status}): ${errorText}`);
  }

  const data = (await response.json()) as {
    translations?: { text: string; detected_source_language?: string }[];
    data?: string;
  };

  let translatedText = '';
  let detectedSourceLanguage = '';

  if (data.translations && data.translations.length > 0) {
    translatedText = data.translations[0]!.text;
    detectedSourceLanguage = data.translations[0]!.detected_source_language || '';
  } else if (data.data) {
    translatedText = data.data;
  }

  if (useCache && translationsKV && translatedText) {
    try {
      const cacheKey = generateCacheKey(text, sourceLang, targetLang);
      await translationsKV.put(cacheKey, translatedText, { expirationTtl: 86400 * 90 });
    } catch (cacheError) {
      console.error('Cache storage error:', cacheError);
    }
  }

  return {
    text: translatedText,
    daily_usage: 0,
    detected_source_language: detectedSourceLanguage,
  };
}

export const Route = createFileRoute('/api/deepl/translate')({
  server: {
    handlers: {
      POST: async ({ request }) =>
        runAuth(request, async ({ user }) => {
          let env: Partial<CloudflareEnv> = {};
          try {
            env = ((await getCloudflareContext()).env || {}) as CloudflareEnv;
          } catch {
            console.warn('Cloudflare context is not available. Skipping KV cache.');
          }
          const hasKVCache = !!env['TRANSLATIONS_KV'];

          const deepFreeApiUrl = appEnv.DEEPL_FREE_API;
          const deeplProApiUrl = appEnv.DEEPL_PRO_API;

          const userPlan = getSubscriptionPlan(user);
          const deeplApiUrl = userPlan === 'pro' ? deeplProApiUrl : deepFreeApiUrl;
          const deeplAuthKey =
            deeplApiUrl === deeplProApiUrl
              ? getDeepLAPIKey(appEnv.DEEPL_PRO_API_KEYS)
              : getDeepLAPIKey(appEnv.DEEPL_FREE_API_KEYS);

          // Per-character daily-quota cap (advisory): block requests that would
          // burst-write more than the plan's daily allowance in a single call.
          // Per-user persisted usage tracking previously lived in a Supabase
          // RPC backed by a `user_usage_stats` table; that table wasn't ported
          // to the drizzle schema, so server-side rolling totals are gone.
          // The client tracks daily_usage in localStorage via saveDailyUsage
          // for UX purposes; the response below echoes 0 to keep the shape.
          const { quota: dailyQuota } = getDailyTranslationPlanData(user);

          const body: {
            text: string[];
            source_lang?: string;
            target_lang?: string;
            use_cache?: boolean;
          } = await request.json();
          const {
            text,
            source_lang: sourceLang = 'AUTO',
            target_lang: targetLang = 'EN',
            use_cache: useCache = false,
          } = body;

          try {
            const totalChars = text.reduce((a, b) => a + (b?.length ?? 0), 0);
            if (totalChars >= dailyQuota) {
              throw new Error(ErrorCodes.DAILY_QUOTA_EXCEEDED);
            }

            const translations = await Promise.all(
              text.map(async (singleText) => {
                if (!singleText?.trim()) {
                  return { text: '', daily_usage: 0 };
                }
                if (useCache && hasKVCache) {
                  try {
                    const cacheKey = generateCacheKey(singleText, sourceLang, targetLang);
                    const cachedTranslation = await env['TRANSLATIONS_KV']!.get(cacheKey);

                    if (cachedTranslation) {
                      return {
                        text: cachedTranslation,
                        daily_usage: 0,
                        detected_source_language: sourceLang,
                      };
                    }
                  } catch (cacheError) {
                    console.error('Cache retrieval error:', cacheError);
                  }
                }

                return await callDeepLAPI(
                  singleText,
                  sourceLang,
                  targetLang,
                  deeplApiUrl,
                  deeplAuthKey,
                  env['TRANSLATIONS_KV'],
                  useCache,
                );
              }),
            );
            return Response.json({ translations });
          } catch (error) {
            if (error instanceof Error && error.message.includes(ErrorCodes.DAILY_QUOTA_EXCEEDED)) {
              return Response.json({ error: ErrorCodes.DAILY_QUOTA_EXCEEDED }, { status: 429 });
            }
            if (error instanceof Error && error.message.includes(ErrorCodes.UNAUTHORIZED)) {
              return Response.json({ error: ErrorCodes.UNAUTHORIZED }, { status: 401 });
            }
            console.error('Error proxying DeepL request:', error);
            return Response.json({ error: ErrorCodes.INTERNAL_SERVER_ERROR }, { status: 500 });
          }
        }),
    },
  },
});
