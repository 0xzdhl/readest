import { getAPIBaseUrl } from '@/services/environment';
import type { UserPlan } from '@/types/quota';
import { getTranslationQuota } from '@/utils/access';
import { fetchWithAuth } from '@/utils/fetch';
import { normalizeToShortLang } from '@/utils/lang';
import { stubTranslation as _ } from '@/utils/misc';
import { isRecord } from '@/utils/unknown';
import { ErrorCodes, type TranslationProvider } from '../types';
import { saveDailyUsage } from '../utils';

const DEEPL_API_ENDPOINT = `${getAPIBaseUrl()}/deepl/translate`;

interface DeepLTranslation {
  text?: string;
  daily_usage?: number;
}

interface DeepLResponse {
  translations?: DeepLTranslation[];
  daily_usage?: number;
}

export const deeplProvider: TranslationProvider = {
  name: 'deepl',
  label: _('DeepL'),
  authRequired: true,
  quotaExceeded: false,
  translate: async (
    text: string[],
    sourceLang: string,
    targetLang: string,
    _token?: string | null,
    useCache: boolean = false,
  ): Promise<string[]> => {
    // Plan-aware quota math is now enforced exclusively by the server
    // (apps/readest-app/src/app/api/deepl/translate.ts reads
    // `session.user.plan` from better-auth). Client-side we treat every
    // signed-in user as having the free-tier soft cap so the local
    // saveDailyUsage write rate-limits politely; the server returns the
    // authoritative `daily_usage` on every response anyway.
    const userPlan: UserPlan = 'free';

    const normalizedSourceLang = normalizeToShortLang(sourceLang).toUpperCase();
    const body = JSON.stringify({
      text: text,
      ...(normalizedSourceLang !== 'AUTO' ? { source_lang: normalizedSourceLang } : {}),
      target_lang: normalizeToShortLang(targetLang).toUpperCase(),
      use_cache: useCache,
    });

    const quota = getTranslationQuota(userPlan);
    try {
      const response = await fetchWithAuth(DEEPL_API_ENDPOINT, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body,
      });

      const data = (await response.json()) as DeepLResponse;
      if (!data.translations) {
        throw new Error('Invalid response from translation service');
      }

      return text.map((line, i) => {
        if (!line?.trim().length) {
          return line;
        }
        const translation = data.translations?.[i];
        if (translation?.daily_usage !== undefined) {
          saveDailyUsage(translation.daily_usage);
          deeplProvider.quotaExceeded = isRecord(data) && Number(data['daily_usage']) >= quota;
        }
        return translation?.text || line;
      });
    } catch (error) {
      if (error instanceof Error && error.message === ErrorCodes.DAILY_QUOTA_EXCEEDED) {
        saveDailyUsage(quota);
        deeplProvider.quotaExceeded = true;
        throw error;
      }
      throw error;
    }
  },
};
