import { useCallback, useEffect } from 'react';
import { useAuth } from '@/context/AuthContext';
import { useSync } from '@/hooks/useSync';
import { type BookNote, FIXED_LAYOUT_FORMATS } from '@/domain/book';
import { useBookDataStore } from '@/store/bookDataStore';
import { useReaderStore } from '@/store/readerStore';
import { SYNC_NOTES_INTERVAL_SEC } from '@/services/constants';
import { throttle } from '@/utils/throttle';
import { getXPointerFromCFI, getCFIFromXPointer, XCFI } from '@/utils/xcfi';
import { getIndexFromCfi } from '@/utils/cfi';

/**
 * Merge an incoming synced note into an existing local note.
 *
 * Content fields are taken from whichever side has the newer `updatedAt`, but
 * the resulting `deletedAt` (the tombstone) is resolved independently as the
 * most-recent deletion across both sides. This prevents a content edit from
 * another device (newer `updatedAt`, `deletedAt=null`) from overwriting a local
 * tombstone and resurrecting a deleted note. A note is only un-deleted when a
 * genuinely newer deletion timestamp clears it — never as a side effect of a
 * content edit.
 */
export const mergeBookNote = (existingNote: BookNote, note: BookNote): BookNote => {
  // Pick the content winner by updatedAt (existing wins ties to stay local-stable).
  const contentWinner = existingNote.updatedAt < note.updatedAt ? note : existingNote;
  // Resolve the tombstone independently: keep the most-recent deletedAt.
  const existingDeletedAt = existingNote.deletedAt ?? 0;
  const incomingDeletedAt = note.deletedAt ?? 0;
  const deletedAt =
    existingDeletedAt >= incomingDeletedAt ? existingNote.deletedAt : note.deletedAt;
  return { ...contentWinner, deletedAt };
};

export const useNotesSync = (bookKey: string) => {
  const { user } = useAuth();
  const { syncedNotes, syncNotes, lastSyncedAtNotes } = useSync(bookKey);
  const { getConfig, setConfig, getBookData } = useBookDataStore();
  const { getView } = useReaderStore();

  const config = getConfig(bookKey);

  const populateXPointersForPush = async (notes: BookNote[]): Promise<BookNote[]> => {
    const bookData = getBookData(bookKey);
    const book = bookData?.book;
    if (!book || FIXED_LAYOUT_FORMATS.has(book.format)) return notes;

    const view = getView(bookKey);
    if (!view) return notes;

    const enriched: BookNote[] = [];
    for (const note of notes) {
      if (note.cfi && !note.xpointer0) {
        try {
          const contents = view.renderer.getContents();
          const primaryIndex = view.renderer.primaryIndex;
          const content = contents.find((x) => x.index === primaryIndex) ?? contents[0];
          if (content) {
            const xpResult = await getXPointerFromCFI(
              note.cfi,
              content.doc,
              content.index || 0,
              bookData.bookDoc ?? undefined,
            );
            enriched.push({
              ...note,
              xpointer0: xpResult.pos0 || xpResult.xpointer,
              xpointer1: xpResult.pos1,
              updatedAt: Date.now(),
            });
            continue;
          }
        } catch {
          // Conversion failed — push without xpointers
        }
      }
      enriched.push(note);
    }
    return enriched;
  };

  const convertXPointersOnPull = async (notes: BookNote[]): Promise<BookNote[]> => {
    const bookData = getBookData(bookKey);
    const book = bookData?.book;
    if (!book || FIXED_LAYOUT_FORMATS.has(book.format)) return notes.filter((n) => n.cfi);

    const view = getView(bookKey);
    const converted: BookNote[] = [];
    for (const note of notes) {
      if (note.xpointer0 && !note.cfi) {
        try {
          let cfi: string | undefined;
          if (note.xpointer1) {
            const spineIndex = XCFI.extractSpineIndex(note.xpointer0);
            const doc = await bookData.bookDoc?.sections?.[spineIndex]?.createDocument();
            if (doc) {
              const converter = new XCFI(doc, spineIndex);
              cfi = converter.xPointerToCFI(note.xpointer0, note.xpointer1);
            }
          } else {
            const contents = view?.renderer.getContents() ?? [];
            const primaryIndex = view?.renderer.primaryIndex;
            const content = contents.find((x) => x.index === primaryIndex) ?? contents[0];
            cfi = await getCFIFromXPointer(
              note.xpointer0,
              content?.doc,
              content?.index,
              bookData.bookDoc ?? undefined,
            );
          }
          if (cfi) {
            let page = note.page;
            if (view) {
              try {
                const progress = await view.getCFIProgress(cfi);
                if (progress) {
                  page = progress.location.current + 1;
                }
              } catch {
                // Page resolution failed — keep original page
              }
            }
            converted.push({ ...note, cfi, page, updatedAt: Date.now() });
          }
        } catch {
          // Conversion failed — discard note
        }
      } else if (note.cfi) {
        converted.push(note);
      }
      // Discard notes with neither cfi nor xpointer
    }
    return converted;
  };

  const getNewNotes = useCallback(() => {
    const config = getConfig(bookKey);
    const book = getBookData(bookKey)?.book;
    if (!config?.location || !book || !user) return {};

    const bookNotes = config.booknotes ?? [];
    const newNotes = bookNotes.filter(
      (note) =>
        !note.xpointer0 ||
        lastSyncedAtNotes < note.updatedAt ||
        lastSyncedAtNotes < (note.deletedAt ?? 0),
    );
    newNotes.forEach((note) => {
      note.bookHash = book.hash;
      note.metaHash = book.metaHash;
    });
    return {
      notes: newNotes,
      lastSyncedAt: lastSyncedAtNotes,
    };
  }, [user, bookKey, lastSyncedAtNotes, getConfig, getBookData]);

  // eslint-disable-next-line react-hooks/exhaustive-deps
  const handleAutoSync = useCallback(
    throttle(
      () => {
        const book = getBookData(bookKey)?.book;
        const newNotes = getNewNotes();
        if (newNotes.notes?.length) {
          populateXPointersForPush(newNotes.notes).then((enriched) => {
            syncNotes(enriched, book?.hash, book?.metaHash, 'both');
          });
        } else {
          syncNotes(newNotes.notes, book?.hash, book?.metaHash, 'both');
        }
      },
      SYNC_NOTES_INTERVAL_SEC * 1000,
      { emitLast: false },
    ),
    [syncNotes],
  );

  useEffect(() => {
    if (!config?.location || !user) return;
    handleAutoSync();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config?.booknotes, handleAutoSync]);

  useEffect(() => {
    const processNewNote = (note: BookNote) => {
      const config = getConfig(bookKey);
      const oldNotes = config?.booknotes ?? [];
      const existingNote = oldNotes.find((oldNote) => oldNote.id === note.id);
      if (existingNote) {
        return mergeBookNote(existingNote, note);
      }
      return note;
    };
    const processSyncedNotes = async () => {
      if (!syncedNotes?.length || !config) return;
      const view = getView(bookKey);
      const book = getBookData(bookKey)?.book;
      const newNotes = syncedNotes.filter(
        (note) => note.bookHash === book?.hash || note.metaHash === book?.metaHash,
      );
      if (!newNotes.length) return;
      // Convert xpointer-only notes (from KOReader) to CFI
      const convertedNotes = await convertXPointersOnPull(newNotes);
      const oldNotes = config.booknotes ?? [];
      const processedNotes = convertedNotes.map(processNewNote);
      processedNotes.forEach((note) => {
        // Render based on the merged result so a note that stays deleted (its
        // local tombstone survived a remote content edit) is never re-rendered.
        if (note.cfi) {
          const index = getIndexFromCfi(note.cfi);
          if (!note.deletedAt && index === view?.renderer.primaryIndex) {
            view.addAnnotation(note);
          }
        }
      });
      const mergedNotes = [
        ...oldNotes.filter((oldNote) => !convertedNotes.some((n) => n.id === oldNote.id)),
        ...processedNotes,
      ];
      setConfig(bookKey, { booknotes: mergedNotes });
    };
    processSyncedNotes();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [syncedNotes]);
};
