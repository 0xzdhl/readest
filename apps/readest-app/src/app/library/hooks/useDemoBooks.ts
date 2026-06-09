import { useEffect, useRef, useState } from 'react';

import type { Book } from '@/domain/book';
import { getUserLang } from '@/utils/misc';
import { isWebAppPlatform } from '@/services/environment';
import { useRunEffect } from '@/context/EffectRuntimeProvider';
import { importBooks } from '@/application/usecases/book';

import libraryEn from '@/data/demo/library.en.json';
import libraryZh from '@/data/demo/library.zh.json';

const libraries = {
  en: libraryEn,
  zh: libraryZh,
};

interface DemoBooks {
  library: string[];
}

export const useDemoBooks = () => {
  const runEffect = useRunEffect();
  const [books, setBooks] = useState<Book[]>([]);
  const isLoading = useRef(false);

  useEffect(() => {
    if (isLoading.current) return;
    isLoading.current = true;

    const userLang = getUserLang() as keyof typeof libraries;
    const fetchDemoBooks = async () => {
      try {
        const demoBooks = libraries[userLang] || (libraries.en as DemoBooks);
        const { imported } = await runEffect(
          importBooks(
            [],
            demoBooks.library.map((url) => ({ file: url })),
            { saveBook: false, persist: false },
          ),
        );
        setBooks(imported);
      } catch (error) {
        console.error('Failed to import demo books:', error);
      }
    };

    const demoBooksFetchedFlag = localStorage.getItem('demoBooksFetched');
    if (isWebAppPlatform() && !demoBooksFetchedFlag) {
      fetchDemoBooks();
      localStorage.setItem('demoBooksFetched', 'true');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return books;
};
