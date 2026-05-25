import { getAPIBaseUrl } from '@/services/environment';
import type { Book, BookConfig, BookDataRecord, BookNote } from '@/types/book';
import { buildAuthFetchOptions, fetchWithTimeout } from '@/utils/fetch';
import { getJsonErrorMessage } from '@/utils/unknown';

const SYNC_API_ENDPOINT = `${getAPIBaseUrl()}/sync`;

export type SyncType = 'books' | 'configs' | 'notes';
export type SyncOp = 'push' | 'pull' | 'both';

interface BookRecord extends BookDataRecord, Book {}
interface BookConfigRecord extends BookDataRecord, BookConfig {}
interface BookNoteRecord extends BookDataRecord, BookNote {}

export interface SyncResult {
  books: BookRecord[] | null;
  notes: BookNoteRecord[] | null;
  configs: BookConfigRecord[] | null;
}

export type SyncRecord = BookRecord & BookConfigRecord & BookNoteRecord;

export interface SyncData {
  books?: Partial<BookRecord>[];
  notes?: Partial<BookNoteRecord>[];
  configs?: Partial<BookConfigRecord>[];
}

export class SyncClient {
  /**
   * Pull incremental changes since a given timestamp (in ms).
   * Returns updated or deleted records since that time.
   */
  async pullChanges(
    since: number,
    type?: SyncType,
    book?: string,
    metaHash?: string,
  ): Promise<SyncResult> {
    const url = `${SYNC_API_ENDPOINT}?since=${encodeURIComponent(since)}&type=${type ?? ''}&book=${book ?? ''}&meta_hash=${metaHash ?? ''}`;
    const options = await buildAuthFetchOptions({});
    const res = await fetchWithTimeout(url, options, 8000);

    if (!res.ok) {
      const error: unknown = await res.json();
      throw new Error(`Failed to pull changes: ${getJsonErrorMessage(error) || res.statusText}`);
    }

    return res.json();
  }

  /**
   * Push local changes to the server.
   * Uses last-writer-wins logic as implemented on the server side.
   */
  async pushChanges(payload: SyncData): Promise<SyncResult> {
    const options = await buildAuthFetchOptions({
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });
    const res = await fetchWithTimeout(SYNC_API_ENDPOINT, options, 8000);

    if (!res.ok) {
      const error: unknown = await res.json();
      throw new Error(`Failed to push changes: ${getJsonErrorMessage(error) || res.statusText}`);
    }

    return res.json();
  }
}
