import type { BookFormat } from '@/domain/book';
import type { LanguageMap, Contributor, Identifier, Collection } from '@/domain/metadata';

export type DocumentFile = File;

export type Location = {
  current: number;
  next: number;
  total: number;
};

export interface TOCItem {
  id: number;
  label: string;
  href: string;
  index: number; // Page index for PDF books
  cfi?: string;
  location?: Location;
  subitems?: TOCItem[];
}

export interface SectionFragment {
  id: string;
  href: string;
  cfi: string;
  size: number;
  linear: string;
  location?: Location;
  fragments?: Array<SectionFragment>;
}

export interface SectionItem {
  id: string;
  cfi: string;
  size: number;
  linear: string;
  href?: string;
  location?: Location;
  pageSpread?: 'left' | 'right' | 'center' | '';
  fragments?: Array<SectionFragment>;

  loadText?: () => Promise<string | null>;
  createDocument: () => Promise<Document>;
}

export type BookMetadata = {
  // NOTE: the title and author fields should be formatted
  title: string | LanguageMap;
  author: string | Contributor;
  language: string | string[];
  editor?: string;
  publisher?: string;
  published?: string;
  description?: string;
  subject?: string | string[] | Contributor;
  identifier?: string;
  isbn?: string;
  altIdentifier?: string | string[] | Identifier;
  belongsTo?: {
    collection?: Array<Collection> | Collection;
    series?: Array<Collection> | Collection;
  };

  subtitle?: string;
  series?: string;
  seriesIndex?: number;
  seriesTotal?: number;

  coverImageFile?: string;
  coverImageUrl?: string;
  coverImageBlobUrl?: string;
};

export interface BookDoc {
  metadata: BookMetadata;
  rendition: {
    layout?: 'pre-paginated' | 'reflowable';
    spread?: 'auto' | 'none';
    viewport?: { width: number; height: number };
  };
  dir: string;
  toc?: Array<TOCItem>;
  sections: Array<SectionItem>;
  transformTarget?: EventTarget;
  splitTOCHref(href: string): Array<string | number>;
  getCover(): Promise<Blob | null>;
}

export const EXTS: Record<BookFormat, string> = {
  EPUB: 'epub',
  PDF: 'pdf',
  MOBI: 'mobi',
  AZW: 'azw',
  AZW3: 'azw3',
  CBZ: 'cbz',
  FB2: 'fb2',
  FBZ: 'fbz',
  TXT: 'txt',
  MD: 'md',
};

export const MIMETYPES: Record<BookFormat, string[]> = {
  EPUB: ['application/epub+zip'],
  PDF: ['application/pdf'],
  MOBI: ['application/x-mobipocket-ebook'],
  AZW: ['application/vnd.amazon.ebook'],
  AZW3: ['application/vnd.amazon.mobi8-ebook', 'application/x-mobi8-ebook'],
  CBZ: ['application/vnd.comicbook+zip', 'application/zip', 'application/x-cbz'],
  FB2: ['application/x-fictionbook+xml', 'text/xml', 'application/xml'],
  FBZ: ['application/x-zip-compressed-fb2', 'application/zip'],
  TXT: ['text/plain'],
  MD: ['text/markdown', 'text/x-markdown'],
};
