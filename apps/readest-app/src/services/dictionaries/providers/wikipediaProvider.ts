/**
 * Built-in Wikipedia provider.
 *
 * Looks up the selection text in `<lang>.wikipedia.org`'s REST summary API
 * and renders the title block (with optional thumbnail-as-background) plus
 * the rendered HTML extract.
 *
 * Extracted from the legacy `WikipediaPopup.tsx`. The legacy popup used
 * `document.querySelector('main')` and `document.querySelector('footer')`
 * — which would break inside a multi-tab popup where those globals point
 * at the wrong tab. This provider writes into `ctx.container` instead.
 * The footer is rendered by the shell; this provider's outcome carries
 * `sourceLabel` so the shell shows attribution.
 */
import type { DictionaryProvider, DictionaryLookupOutcome } from '../types';
import { BUILTIN_PROVIDER_IDS } from '../types';
import { stubTranslation as _ } from '@/utils/misc';
import { isTauriAppPlatform } from '@/services/environment';
import { isRecord } from '@/utils/unknown';

const isTauri = isTauriAppPlatform();

export const wikipediaProvider: DictionaryProvider = {
  id: BUILTIN_PROVIDER_IDS.wikipedia,
  kind: 'builtin',
  label: _('Wikipedia'),
  async lookup(word, ctx): Promise<DictionaryLookupOutcome> {
    const bookLang = typeof ctx.lang === 'string' ? ctx.lang : ctx.lang?.[0];
    const langCode = bookLang ? bookLang.split('-')[0]! : 'en';
    try {
      const response = await fetch(
        `https://${langCode}.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(word)}`,
        { signal: ctx.signal },
      );
      if (!response.ok) {
        return { ok: false, reason: 'error', message: `HTTP ${response.status}` };
      }
      const data: unknown = await response.json();
      if (!isRecord(data)) {
        return { ok: false, reason: 'error', message: 'Invalid response' };
      }
      if (ctx.signal.aborted) return { ok: false, reason: 'error', message: 'aborted' };

      const hgroup = document.createElement('hgroup');
      hgroup.style.color = 'white';
      hgroup.style.backgroundPosition = 'center center';
      hgroup.style.backgroundSize = 'cover';
      hgroup.style.backgroundColor = 'rgba(0, 0, 0, .4)';
      hgroup.style.backgroundBlendMode = 'darken';
      hgroup.style.borderRadius = '6px';
      hgroup.style.padding = '12px';
      hgroup.style.marginBottom = '12px';
      hgroup.style.minHeight = '100px';

      const h1 = document.createElement('h1');
      const titles = isRecord(data['titles']) ? data['titles'] : undefined;
      h1.innerHTML = typeof titles?.['display'] === 'string' ? titles['display'] : word;
      h1.className = 'text-lg font-bold';
      hgroup.appendChild(h1);

      if (typeof data['description'] === 'string') {
        const description = document.createElement('p');
        description.innerText = data['description'];
        hgroup.appendChild(description);
      }

      const thumbnail = isRecord(data['thumbnail']) ? data['thumbnail'] : undefined;
      if (typeof thumbnail?.['source'] === 'string') {
        hgroup.style.backgroundImage = `url("${thumbnail['source']}")`;
      }

      const contentDiv = document.createElement('div');
      contentDiv.innerHTML = typeof data['extract_html'] === 'string' ? data['extract_html'] : '';
      contentDiv.className = 'p-2 text-sm';
      if (typeof data['dir'] === 'string') contentDiv.dir = data['dir'];

      ctx.container.appendChild(hgroup);
      ctx.container.appendChild(contentDiv);

      // "Read on Wikipedia" link. The REST summary endpoint returns
      // `content_urls.{desktop,mobile}.page` pointing at the canonical
      // article. Fall back to a constructed URL if the API ever stops
      // sending content_urls (it has been stable for years, but be safe).
      const articleUrl: string =
        (() => {
          const contentUrls = isRecord(data['content_urls']) ? data['content_urls'] : undefined;
          const desktop = isRecord(contentUrls?.['desktop']) ? contentUrls['desktop'] : undefined;
          const mobile = isRecord(contentUrls?.['mobile']) ? contentUrls['mobile'] : undefined;
          return typeof desktop?.['page'] === 'string'
            ? desktop['page']
            : typeof mobile?.['page'] === 'string'
              ? mobile['page']
              : undefined;
        })() ?? `https://${langCode}.wikipedia.org/wiki/${encodeURIComponent(word)}`;

      const linkWrapper = document.createElement('p');
      linkWrapper.className = 'mt-3 px-2 text-sm';
      const link = document.createElement('a');
      link.href = articleUrl;
      // Skip target="_blank" on Tauri. iOS WebView dispatches a separate
      // "open externally" path for `_blank` anchors that goes through the
      // shell scope and fails with "Operation not permitted" — even when
      // a click handler `preventDefault`s. The popup's container click
      // handler routes the click through `openUrl` instead.
      if (!isTauri) link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.className = 'not-eink:text-primary underline';
      link.textContent = _('Read on Wikipedia →');
      linkWrapper.appendChild(link);
      ctx.container.appendChild(linkWrapper);

      return { ok: true, headword: word, sourceLabel: 'Wikipedia (CC BY-SA)' };
    } catch (error) {
      if ((error as { name?: string }).name === 'AbortError') {
        return { ok: false, reason: 'error', message: 'aborted' };
      }
      console.error('Wikipedia lookup failed', error);
      return {
        ok: false,
        reason: 'error',
        message: error instanceof Error ? error.message : String(error),
      };
    }
  },
};
