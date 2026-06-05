import type { SectionFragment, TOCItem } from '@/domain/document';

// -----------------------------------------------------------------------------
// Book navigation artifact (persisted to Books/{hash}/nav.json).
// Bump BOOK_NAV_VERSION whenever computeBookNav output semantics change
// (TOC grouping heuristic, fragment CFI/size math, hierarchy rules).
// v2: fragment CFIs are derived from the section DOM via CFI.joinIndir instead
//     of inherited from the TOC item (ported from foliate-js 317051e).
// v3: nav-enrichment fallback — when toc.ncx is sparse, scan section HTMLs for
//     embedded <nav> elements and merge their links as top-level TOC items.
// -----------------------------------------------------------------------------

export const BOOK_NAV_VERSION = 3;

export interface BookNavSection {
  id: string;
  fragments: SectionFragment[];
}

export interface BookNav {
  version: number;
  toc: TOCItem[];
  sections: Record<string, BookNavSection>;
}
