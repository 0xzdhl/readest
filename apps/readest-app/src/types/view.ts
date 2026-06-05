import type { BookNote } from '@/domain/book';
import type { FoliateView } from '@/domain/view';

export type { Renderer, FoliateView } from '@/domain/view';

export const NOTE_PREFIX = 'foliate-note:';

export const wrappedFoliateView = (originalView: FoliateView): FoliateView => {
  const originalAddAnnotation = originalView.addAnnotation.bind(originalView);
  originalView.addAnnotation = (note: BookNote, remove = false) => {
    // transform BookNote to foliate annotation
    const annotation = {
      value: note.cfi,
      ...note,
    };
    return originalAddAnnotation(annotation, remove);
  };
  return originalView;
};
