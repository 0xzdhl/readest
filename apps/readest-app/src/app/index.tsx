import { createFileRoute } from '@tanstack/react-router';
import LibraryPage from './library/page';

export const route = createFileRoute('/')({
  component: LibraryPage,
});
