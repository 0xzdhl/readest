import { getCurrentUserNamespace } from '@/services/userNamespace';

export const getUserNamespaceDir = (): string => `users/${getCurrentUserNamespace()}`;
export const getLibraryStoragePath = (): string => `${getUserNamespaceDir()}/library.json`;
export const getConfigStoragePath = (book: { hash: string }): string =>
  `${getUserNamespaceDir()}/${book.hash}/config.json`;
