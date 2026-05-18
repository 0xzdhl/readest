// Temporarily declare js-mdict at local. This should be removed in the future.

declare module 'js-mdict' {
  export interface MDictOptions {
    passcode?: string;
    debug?: boolean;
    resort?: boolean;
    isStripKey?: boolean;
    isCaseSensitive?: boolean;
    encryptType?: number;
  }

  export interface MDictMeta {
    encrypt: number;
    version: number;
  }

  export interface KeyWordItem {
    recordStartOffset: number;
    recordEndOffset: number;
    keyText: string;
    keyBlockIdx: number;
  }

  export interface LookupResult {
    keyText: string;
    definition: string | null;
  }

  export interface LocateBytesResult {
    keyText: string;
    data: Uint8Array | null;
  }

  export class BlobScanner {
    constructor(file: Blob);
    readBuffer(offset: number | bigint, length: number): Promise<Uint8Array>;
  }

  export class MDX {
    constructor(scanner: BlobScanner, name: string, options?: Partial<MDictOptions>);
    static create(file: Blob, options?: Partial<MDictOptions>): Promise<MDX>;
    header: Record<string, unknown>;
    meta: MDictMeta;
    keywordList: KeyWordItem[];
    init(): Promise<void>;
    lookup(word: string): LookupResult | Promise<LookupResult>;
  }

  export class MDD {
    constructor(scanner: BlobScanner, name: string, options?: Partial<MDictOptions>);
    static create(file: Blob, options?: Partial<MDictOptions>): Promise<MDD>;
    header: Record<string, unknown>;
    meta: MDictMeta;
    keywordList: KeyWordItem[];
    init(): Promise<void>;
    locate(key: string): LookupResult | Promise<LookupResult>;
    locateBytes(key: string): LocateBytesResult | Promise<LocateBytesResult>;
  }
}
