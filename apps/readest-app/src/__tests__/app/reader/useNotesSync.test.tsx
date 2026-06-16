import { describe, expect, it } from 'vitest';
import type { BookNote } from '@/domain/book';
import { mergeBookNote } from '@/app/reader/hooks/useNotesSync';

const baseNote = (overrides: Partial<BookNote>): BookNote => ({
  id: 'n1',
  type: 'annotation',
  cfi: 'epubcfi(/6/4!/4/2)',
  note: '',
  createdAt: 1,
  updatedAt: 1,
  ...overrides,
});

describe('mergeBookNote — tombstone resurrection race', () => {
  it('keeps a locally deleted note deleted when a remote content edit arrives', () => {
    // Local device deleted the note: deletedAt=T2 set, updatedAt unchanged at T1.
    const existingNote = baseNote({ updatedAt: 100, deletedAt: 200, note: 'old' });
    // Another device edited the content: newer updatedAt=T3, but never deleted (deletedAt=null).
    const incomingNote = baseNote({ updatedAt: 300, deletedAt: null, note: 'edited' });

    const merged = mergeBookNote(existingNote, incomingNote);

    // The newer content edit should win for content fields...
    expect(merged.note).toBe('edited');
    expect(merged.updatedAt).toBe(300);
    // ...but the deletion must be preserved (no resurrection).
    expect(merged.deletedAt).toBe(200);
  });

  it('un-deletes only when a genuinely newer un-delete exists', () => {
    // Local deleted at T2; remote un-deleted afterwards (deletedAt cleared) at T3.
    const existingNote = baseNote({ updatedAt: 100, deletedAt: 200 });
    const incomingNote = baseNote({ updatedAt: 300, deletedAt: null, note: 'revived' });

    // Same as above by timestamps — a content edit cannot un-delete.
    const merged = mergeBookNote(existingNote, incomingNote);
    expect(merged.deletedAt).toBe(200);
  });

  it('propagates a remote deletion onto a local live note', () => {
    const existingNote = baseNote({ updatedAt: 100, deletedAt: null });
    const incomingNote = baseNote({ updatedAt: 100, deletedAt: 500 });

    const merged = mergeBookNote(existingNote, incomingNote);
    expect(merged.deletedAt).toBe(500);
  });

  it('takes content from the newer side for normal non-deleted edits', () => {
    const existingNote = baseNote({ updatedAt: 100, note: 'old', deletedAt: null });
    const incomingNote = baseNote({ updatedAt: 200, note: 'new', deletedAt: null });

    const merged = mergeBookNote(existingNote, incomingNote);
    expect(merged.note).toBe('new');
    expect(merged.updatedAt).toBe(200);
    expect(merged.deletedAt == null).toBe(true);
  });

  it('keeps the local note when it is the newer side', () => {
    const existingNote = baseNote({ updatedAt: 300, note: 'local', deletedAt: null });
    const incomingNote = baseNote({ updatedAt: 100, note: 'remote', deletedAt: null });

    const merged = mergeBookNote(existingNote, incomingNote);
    expect(merged.note).toBe('local');
    expect(merged.updatedAt).toBe(300);
  });
});
