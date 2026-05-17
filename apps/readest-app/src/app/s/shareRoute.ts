import { resolveActiveShare } from '@/libs/shareServer';
import { READEST_WEB_BASE_URL, SHARE_BASE_URL } from '@/services/constants';

export interface SharePageData {
  title: string;
  description: string;
  ogImage?: string;
  shareUrl?: string;
}

export const loadSharePage = async (token: string): Promise<SharePageData | null> => {
  if (!token) {
    return null;
  }

  const result = await resolveActiveShare(token);
  if (!result.ok) {
    return null;
  }
  const { share } = result;
  const shareUrl = `${SHARE_BASE_URL}/${token}`;
  const ogImage = `${READEST_WEB_BASE_URL}/api/share/${token}/og.png`;

  return {
    title: `${share.bookTitle} · Shared via Readest`,
    description: share.bookAuthor
      ? `${share.bookAuthor} · Shared via Readest`
      : 'Shared via Readest',
    ogImage,
    shareUrl,
  };
};

export const buildShareHead = (loaderData: SharePageData | null | undefined) => {
  if (!loaderData) {
    return {
      title: 'Open in Readest',
      meta: [
        {
          name: 'description',
          content: 'Open-source ebook reader for everyone, on every device.',
        },
      ],
    };
  }

  return {
    title: loaderData.title,
    meta: [
      { name: 'description', content: loaderData.description },
      { property: 'og:type', content: 'book' },
      { property: 'og:url', content: loaderData.shareUrl },
      { property: 'og:title', content: loaderData.title },
      { property: 'og:description', content: loaderData.description },
      { property: 'og:image', content: loaderData.ogImage },
      { property: 'og:image:width', content: '1200' },
      { property: 'og:image:height', content: '630' },
      { property: 'twitter:card', content: 'summary_large_image' },
      { property: 'twitter:title', content: loaderData.title },
      { property: 'twitter:description', content: loaderData.description },
      { property: 'twitter:image', content: loaderData.ogImage },
    ],
  };
};
