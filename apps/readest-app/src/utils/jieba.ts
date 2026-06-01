import init, { cut } from 'jieba-wasm';

let initialized = false;
let initPromise: Promise<void> | null = null;

const initJieba = async (): Promise<void> => {
  if (initialized) return;
  if (!initPromise) {
    initPromise = (async () => {
      try {
        // No argument: the wasm-bindgen glue resolves the wasm via
        // `new URL('jieba_rs_wasm_bg.wasm', import.meta.url)`, which Vite
        // rewrites to the content-hashed asset it already emits. This avoids
        // shipping a second, un-hashed copy under /vendor/jieba.
        await init();
        initialized = true;
      } catch (e) {
        initPromise = null;
        throw e;
      }
    })();
  }
  return initPromise;
};

const isJiebaReady = (): boolean => initialized;

const cutZh = (text: string): string[] => {
  return cut(text, true);
};

export { initJieba, isJiebaReady, cutZh };
