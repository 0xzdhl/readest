import { Effect, Layer, Option } from 'effect';
import { PlatformError } from '@/application/errors/AppError';
import { Dialog, type DialogShape } from '@/application/ports/Dialog';
import type { SaveFileOptions } from '@/application/ports/Dialog';
import type { SelectDirectoryMode } from '@/domain/system';

/**
 * Faithful port of the legacy web dialog methods
 * into the `DialogShape` port.
 *
 * - `ask`:              `window.confirm(message)` — synchronous, wrapped in Effect.
 * - `selectDirectory`:  Not supported in browser — fails with PlatformError.
 * - `selectFiles`:      Not supported in browser — fails with PlatformError.
 * - `saveFile`:         `navigator.share` (when options.share + API available) else
 *                       `<a download>` blob link. Returns `Option.some(filename)` on
 *                       success, `Option.none()` if the user dismisses the share sheet
 *                       (AbortError). Map failures → `PlatformError`.
 */
export const WebDialogLive = Layer.succeed(Dialog, {
  ask: (message: string): Effect.Effect<boolean, PlatformError> =>
    Effect.try({
      try: () => window.confirm(message),
      catch: (cause) => new PlatformError({ operation: 'ask', cause }),
    }),

  selectDirectory: (
    _mode: SelectDirectoryMode,
  ): Effect.Effect<Option.Option<string>, PlatformError> =>
    Effect.fail(
      new PlatformError({ operation: 'selectDirectory', cause: 'not supported in browser' }),
    ),

  selectFiles: (
    _name: string,
    _extensions: string[],
  ): Effect.Effect<readonly string[], PlatformError> =>
    Effect.fail(new PlatformError({ operation: 'selectFiles', cause: 'not supported in browser' })),

  saveFile: (
    filename: string,
    content: string | ArrayBuffer,
    options?: SaveFileOptions,
  ): Effect.Effect<Option.Option<string>, PlatformError> => {
    const mimeType = options?.mimeType ?? 'application/octet-stream';

    if (
      options?.share &&
      typeof navigator !== 'undefined' &&
      typeof navigator.share === 'function'
    ) {
      return Effect.tryPromise({
        try: async () => {
          let shareData: ShareData | null = null;
          try {
            const file = new File([content], filename, { type: mimeType });
            const candidate: ShareData = { files: [file], title: filename };
            if (typeof navigator.canShare !== 'function' || navigator.canShare(candidate)) {
              shareData = candidate;
            }
          } catch (error) {
            // File constructor unavailable or rejected the input; fall through to download.
            console.warn('Failed to build share file; falling back to download:', error);
          }

          if (shareData) {
            try {
              await navigator.share(shareData);
              return Option.some(filename);
            } catch (error) {
              // AbortError = user dismissed the sheet; respect that as an explicit
              // "don't share" choice — return none. Any other error means the share
              // never happened — fall through to the download fallback.
              if ((error as DOMException)?.name === 'AbortError') {
                return Option.none<string>();
              }
              console.warn('navigator.share failed; falling back to download:', error);
            }
          }

          // Download fallback
          const blob = new Blob([content], { type: mimeType });
          const url = URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = url;
          a.download = filename;
          document.body.appendChild(a);
          a.click();
          document.body.removeChild(a);
          URL.revokeObjectURL(url);
          return Option.some(filename);
        },
        catch: (cause) => new PlatformError({ operation: 'saveFile', cause }),
      });
    }

    // Non-share path: always use the <a download> approach.
    return Effect.tryPromise({
      try: async () => {
        const blob = new Blob([content], { type: mimeType });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        return Option.some(filename);
      },
      catch: (cause) => new PlatformError({ operation: 'saveFile', cause }),
    });
  },
} satisfies DialogShape);
