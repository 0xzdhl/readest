export type FontFormat = 'ttf' | 'otf' | 'woff' | 'woff2';

export interface CustomFont {
  id: string;
  name: string;
  path: string;
  family?: string;
  style?: string;
  weight?: number;
  variable?: boolean;

  /**
   * Cross-device content hash. Set on imports new enough to participate
   * in replica sync (`partialMd5 + byteSize + filename`). Legacy fonts
   * (created before replica sync) leave this undefined and never publish
   * — re-import to enable cloud sync.
   */
  contentId?: string;
  /**
   * Per-font directory name relative to the `Fonts` base. New imports
   * land at `<bundleDir>/<filename>`; legacy imports keep their flat
   * `<filename>` path with bundleDir undefined.
   */
  bundleDir?: string;
  /** File size in bytes — used by the replica manifest, optional for legacy. */
  byteSize?: number;
  /**
   * On a remote-pulled placeholder, set to true until the binary download
   * lands. The transfer-complete handler clears it via the font store's
   * markAvailable hook.
   */
  unavailable?: boolean;
  /**
   * Reincarnation token — opaque value that revives a tombstoned remote
   * row. Mirrors the dictionary mechanism.
   */
  reincarnation?: string;

  downloadedAt?: number;
  deletedAt?: number;

  blobUrl?: string;
  loaded?: boolean;
  error?: string;
}

export type CustomFontInfo = Partial<CustomFont> &
  Required<Pick<CustomFont, 'path' | 'name' | 'family' | 'style' | 'weight' | 'variable'>>;
