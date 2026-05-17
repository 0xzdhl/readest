import { createFileRoute } from '@tanstack/react-router';
import type { PostgrestError } from '@supabase/supabase-js';
import { createSupabaseClient } from '@/utils/supabase';
import type { BookDataRecord } from '@/types/book';
import { transformBookConfigToDB } from '@/utils/transform';
import { transformBookNoteToDB } from '@/utils/transform';
import { transformBookToDB } from '@/utils/transform';
import type { SyncData, SyncRecord, SyncResult, SyncType } from '@/libs/sync';
import { validateUserAndToken } from '@/utils/access';
import type { DBBook, DBBookConfig } from '@/types/records';

const transformsToDB = {
  books: transformBookToDB,
  book_notes: transformBookNoteToDB,
  book_configs: transformBookConfigToDB,
};

const DBSyncTypeMap = {
  books: 'books',
  book_notes: 'notes',
  book_configs: 'configs',
};

type TableName = keyof typeof transformsToDB;

type DBError = { table: TableName; error: PostgrestError };

async function handleGet(request: Request): Promise<Response> {
  const { user, token } = await validateUserAndToken(
    request.headers.get('authorization') ?? undefined,
  );
  if (!user || !token) {
    return Response.json({ error: 'Not authenticated' }, { status: 403 });
  }
  const supabase = createSupabaseClient(token);

  const { searchParams } = new URL(request.url);
  const sinceParam = searchParams.get('since');
  const typeParam = searchParams.get('type') as SyncType | undefined;
  const bookParam = searchParams.get('book');
  const metaHashParam = searchParams.get('meta_hash');

  if (!sinceParam) {
    return Response.json({ error: '"since" query parameter is required' }, { status: 400 });
  }

  const since = new Date(Number(sinceParam));
  if (isNaN(since.getTime())) {
    return Response.json({ error: 'Invalid "since" timestamp' }, { status: 400 });
  }

  const sinceIso = since.toISOString();

  try {
    const results: SyncResult = { books: [], configs: [], notes: [] };
    const errors: Record<TableName, DBError | null> = {
      books: null,
      book_notes: null,
      book_configs: null,
    };

    const queryTables = async (table: TableName, dedupeKeys?: (keyof BookDataRecord)[]) => {
      const PAGE_SIZE = 1000;
      let allRecords: SyncRecord[] = [];
      let offset = 0;
      let hasMore = true;

      while (hasMore) {
        let query = supabase
          .from(table)
          .select('*')
          .eq('user_id', user.id)
          .range(offset, offset + PAGE_SIZE - 1);

        if (bookParam && metaHashParam) {
          query = query.or(`book_hash.eq.${bookParam},meta_hash.eq.${metaHashParam}`);
        } else if (bookParam) {
          query = query.eq('book_hash', bookParam);
        } else if (metaHashParam) {
          query = query.eq('meta_hash', metaHashParam);
        }

        query = query.or(`updated_at.gt.${sinceIso},deleted_at.gt.${sinceIso}`);
        query = query.order('updated_at', { ascending: false });

        console.log('Querying table:', table, 'since:', sinceIso, 'offset:', offset);

        const { data, error } = await query;
        if (error) throw { table, error } as DBError;

        if (data && data.length > 0) {
          allRecords = allRecords.concat(data);
          offset += PAGE_SIZE;
          hasMore = data.length === PAGE_SIZE;
        } else {
          hasMore = false;
        }
      }

      let records = allRecords;
      if (dedupeKeys && dedupeKeys.length > 0) {
        const seen = new Set<string>();
        records = records.filter((rec) => {
          const key = dedupeKeys
            .map((k) => rec[k])
            .filter(Boolean)
            .join('|');
          if (key && seen.has(key)) {
            return false;
          } else {
            seen.add(key);
            return true;
          }
        });
      }
      results[DBSyncTypeMap[table] as SyncType] = records || [];
    };

    if (!typeParam || typeParam === 'books') {
      await queryTables('books').catch((err) => (errors['books'] = err));
      // TODO: Remove this hotfix for the initial race condition for books sync
      if (results.books?.length === 0 && since.getTime() < 1000) {
        const dummyHash = '00000000000000000000000000000000';
        const now = Date.now();
        results.books.push({
          user_id: user.id,
          id: dummyHash,
          book_hash: dummyHash,
          deleted_at: now,
          updated_at: now,

          hash: dummyHash,
          title: 'Dummy Book',
          format: 'EPUB',
          author: '',
          createdAt: now,
          updatedAt: now,
          deletedAt: now,
        });
      }
    }
    if (!typeParam || typeParam === 'configs') {
      await queryTables('book_configs').catch((err) => (errors['book_configs'] = err));
    }
    if (!typeParam || typeParam === 'notes') {
      await queryTables('book_notes', ['id']).catch((err) => (errors['book_notes'] = err));
    }

    const dbErrors = Object.values(errors).filter((err) => err !== null);
    if (dbErrors.length > 0) {
      console.error('Errors occurred:', dbErrors);
      const errorMsg = dbErrors
        .map((err) => `${err.table}: ${err.error.message || 'Unknown error'}`)
        .join('; ');
      return Response.json({ error: errorMsg }, { status: 500 });
    }

    return Response.json(results, {
      status: 200,
      headers: {
        'Cache-Control': 'no-store',
        Pragma: 'no-cache',
      },
    });
  } catch (error: unknown) {
    console.error(error);
    const errorMessage = (error as PostgrestError).message || 'Unknown error';
    return Response.json({ error: errorMessage }, { status: 500 });
  }
}

async function handlePost(request: Request): Promise<Response> {
  const { user, token } = await validateUserAndToken(
    request.headers.get('authorization') ?? undefined,
  );
  if (!user || !token) {
    return Response.json({ error: 'Not authenticated' }, { status: 403 });
  }
  const supabase = createSupabaseClient(token);
  const body = await request.json();
  const { books = [], configs = [], notes = [] } = body as SyncData;

  const BATCH_SIZE = 100;
  const upsertRecords = async (
    table: TableName,
    primaryKeys: (keyof BookDataRecord)[],
    records: BookDataRecord[],
  ) => {
    if (records.length === 0) return { data: [] };

    const allAuthoritativeRecords: BookDataRecord[] = [];

    // Process in batches
    for (let i = 0; i < records.length; i += BATCH_SIZE) {
      const batch = records.slice(i, i + BATCH_SIZE);

      // Transform all records to DB format
      const dbRecords = batch.map((rec) => {
        const dbRec = transformsToDB[table](rec, user.id);
        rec.user_id = user.id;
        rec.book_hash = dbRec.book_hash;
        return { original: rec, db: dbRec };
      });

      // Build match conditions for batch
      const matchConditions = dbRecords.map(({ original }) => {
        const conditions: Record<string, string | number> = { user_id: user.id };
        for (const pk of primaryKeys) {
          conditions[pk] = original[pk]!;
        }
        return conditions;
      });

      // Fetch existing records for this batch
      const orConditions = matchConditions
        .map((cond) => {
          const parts = Object.entries(cond).map(([key, val]) => `${key}.eq.${val}`);
          return `and(${parts.join(',')})`;
        })
        .join(',');

      const { data: serverRecords, error: fetchError } = await supabase
        .from(table)
        .select()
        .or(orConditions);

      if (fetchError) {
        return { error: fetchError.message };
      }

      // Create lookup map
      const serverRecordsMap = new Map<string, BookDataRecord>();
      (serverRecords || []).forEach((record) => {
        const key = primaryKeys.map((pk) => record[pk]).join('|');
        serverRecordsMap.set(key, record);
      });

      // Separate into inserts and updates
      const toInsert: (DBBook | DBBookConfig | DBBookConfig)[] = [];
      const toUpdate: (DBBook | DBBookConfig | DBBookConfig)[] = [];
      const batchAuthoritativeRecords: BookDataRecord[] = [];

      for (const { original, db: dbRec } of dbRecords) {
        const key = primaryKeys.map((pk) => original[pk]).join('|');
        const serverData = serverRecordsMap.get(key);

        if (!serverData) {
          dbRec.updated_at = new Date().toISOString();
          toInsert.push(dbRec);
        } else {
          const clientUpdatedAt = dbRec.updated_at ? new Date(dbRec.updated_at).getTime() : 0;
          const serverUpdatedAt = serverData.updated_at
            ? new Date(serverData.updated_at).getTime()
            : 0;
          const clientDeletedAt = dbRec.deleted_at ? new Date(dbRec.deleted_at).getTime() : 0;
          const serverDeletedAt = serverData.deleted_at
            ? new Date(serverData.deleted_at).getTime()
            : 0;
          const clientIsNewer =
            clientDeletedAt > serverDeletedAt || clientUpdatedAt > serverUpdatedAt;

          if (clientIsNewer) {
            toUpdate.push(dbRec);
          } else {
            batchAuthoritativeRecords.push(serverData);
          }
        }
      }

      // Batch insert
      if (toInsert.length > 0) {
        const { data: inserted, error: insertError } = await supabase
          .from(table)
          .insert(toInsert)
          .select();

        if (insertError) {
          console.log(`Failed to insert ${table} records:`, JSON.stringify(toInsert));
          return { error: insertError.message };
        }
        batchAuthoritativeRecords.push(...(inserted || []));
      }

      // Batch upsert
      if (toUpdate.length > 0) {
        const { data: updated, error: updateError } = await supabase
          .from(table)
          .upsert(toUpdate, {
            onConflict: ['user_id', ...primaryKeys].join(','),
          })
          .select();

        if (updateError) {
          console.log(`Failed to update ${table} records:`, JSON.stringify(toUpdate));
          return { error: updateError.message };
        }
        batchAuthoritativeRecords.push(...(updated || []));
      }

      allAuthoritativeRecords.push(...batchAuthoritativeRecords);
    }

    return { data: allAuthoritativeRecords };
  };

  try {
    const [booksResult, configsResult, notesResult] = await Promise.all([
      upsertRecords('books', ['book_hash'], books as BookDataRecord[]),
      upsertRecords('book_configs', ['book_hash'], configs as BookDataRecord[]),
      upsertRecords('book_notes', ['book_hash', 'id'], notes as BookDataRecord[]),
    ]);

    if (booksResult?.error) throw new Error(booksResult.error);
    if (configsResult?.error) throw new Error(configsResult.error);
    if (notesResult?.error) throw new Error(notesResult.error);

    return Response.json(
      {
        books: booksResult?.data || [],
        configs: configsResult?.data || [],
        notes: notesResult?.data || [],
      },
      { status: 200 },
    );
  } catch (error: unknown) {
    console.error(error);
    const errorMessage = (error as PostgrestError).message || 'Unknown error';
    return Response.json({ error: errorMessage }, { status: 500 });
  }
}

export const Route = createFileRoute('/api/sync')({
  server: {
    handlers: {
      GET: async ({ request }) => handleGet(request),
      POST: async ({ request }) => handlePost(request),
    },
  },
});
