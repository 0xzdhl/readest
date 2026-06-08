import { Effect, Layer, Option } from 'effect';
import { open as openDialog, save as saveDialog, ask } from '@tauri-apps/plugin-dialog';
import { writeFile, writeTextFile } from '@tauri-apps/plugin-fs';
import { type as osType } from '@tauri-apps/plugin-os';
import { shareFile } from '@choochmeque/tauri-plugin-sharekit-api';
import { PlatformError } from '@/application/errors/AppError';
import { Dialog, type DialogShape } from '@/application/ports/Dialog';
import type { SaveFileOptions } from '@/application/ports/Dialog';
import type { SelectDirectoryMode } from '@/domain/system';
import { PathResolver } from '@/application/ports/PathResolver';

const safeDecodePath = (input: string): string => {
  try {
    return decodeURI(input);
  } catch {
    return input;
  }
};

/**
 * Faithful port of the NativeAppService dialog methods
 * (src/services/nativeAppService.ts:544–620) into the `DialogShape` port.
 * Every platform call is wrapped in `Effect.tryPromise` mapping throws to
 * `PlatformError`. Edge-cases preserved:
 *   - `selectFiles`: iOS path-decode (safeDecodePath).
 *   - `saveFile`: sharekit (`@choochmeque/tauri-plugin-sharekit-api`) branch for
 *     iOS / non-Linux, with fallback to `saveDialog`; returns `Option.none()` on
 *     cancel (filePath=null), `Option.some(path)` on success or share-complete.
 */
export const TauriDialogLive = Layer.effect(
  Dialog,
  Effect.gen(function* () {
    const resolver = yield* PathResolver;

    // OS_TYPE calls a Tauri API; compute it when the layer builds (Tauri-only),
    // not at import, so web/test contexts can import this module safely.
    const OS_TYPE = osType();
    const isLinuxApp = OS_TYPE === 'linux';

    const dialogAsk = (message: string): Effect.Effect<boolean, PlatformError> =>
      Effect.tryPromise({
        try: () => ask(message),
        catch: (cause) => new PlatformError({ operation: 'ask', cause }),
      });

    const selectDirectory = (
      _mode: SelectDirectoryMode,
    ): Effect.Effect<Option.Option<string>, PlatformError> =>
      Effect.tryPromise({
        try: async () => {
          const selected = await openDialog({
            directory: true,
            multiple: false,
            recursive: true,
          });
          return Option.fromNullable(selected as string | null);
        },
        catch: (cause) => new PlatformError({ operation: 'selectDirectory', cause }),
      });

    const selectFiles = (
      name: string,
      extensions: string[],
    ): Effect.Effect<readonly string[], PlatformError> =>
      Effect.tryPromise({
        try: async () => {
          const selected = await openDialog({
            multiple: true,
            filters: [{ name, extensions }],
          });
          const files = Array.isArray(selected) ? selected : selected ? [selected] : [];
          const paths: string[] = OS_TYPE === 'ios' ? files.map(safeDecodePath) : files;
          return paths as readonly string[];
        },
        catch: (cause) => new PlatformError({ operation: 'selectFiles', cause }),
      });

    const saveFile = (
      filename: string,
      content: string | ArrayBuffer,
      options?: SaveFileOptions,
    ): Effect.Effect<Option.Option<string>, PlatformError> => {
      const ext = filename.split('.').pop() ?? '';
      // Linux desktop has no system share sheet; always fall through to saveDialog.
      const wantShare = !isLinuxApp && (OS_TYPE === 'ios' || options?.share);

      if (wantShare) {
        // Resolve temp path if no explicit filePath given, then attempt shareFile.
        const resolveSharePath = options?.filePath
          ? Effect.succeed(options.filePath)
          : resolver.absolute(filename, 'Temp');

        return resolveSharePath.pipe(
          Effect.flatMap((shareablePath) =>
            Effect.tryPromise({
              try: async () => {
                if (!options?.filePath) {
                  if (typeof content === 'string') {
                    await writeTextFile(shareablePath, content);
                  } else {
                    await writeFile(shareablePath, new Uint8Array(content as ArrayBuffer));
                  }
                }
                try {
                  await shareFile(shareablePath, {
                    mimeType: options?.mimeType ?? 'application/octet-stream',
                    // Anchor the macOS NSSharingServicePicker / iPad popover to
                    // the trigger button. Without this, the picker pops at the
                    // WebView's top-left corner.
                    ...(options?.sharePosition ? { position: options.sharePosition } : {}),
                  });
                  return Option.some(shareablePath);
                } catch (error) {
                  console.error('shareFile failed; falling back to saveDialog:', error);
                  // Fall through: return null sentinel to indicate share failed
                  return null as unknown as Option.Option<string>;
                }
              },
              catch: (cause) => new PlatformError({ operation: 'saveFile', cause }),
            }),
          ),
          Effect.flatMap((result) => {
            // If shareFile succeeded, result is Option.some; otherwise null means fall through.
            if (result !== null) return Effect.succeed(result);
            return saveDialogFallback(filename, content, ext, options);
          }),
          Effect.mapError((cause) =>
            cause instanceof PlatformError
              ? cause
              : new PlatformError({ operation: 'saveFile', cause }),
          ),
        );
      }

      return saveDialogFallback(filename, content, ext, options);
    };

    const saveDialogFallback = (
      filename: string,
      content: string | ArrayBuffer,
      ext: string,
      _options?: SaveFileOptions,
    ): Effect.Effect<Option.Option<string>, PlatformError> =>
      Effect.tryPromise({
        try: async () => {
          const filePath = await saveDialog({
            defaultPath: filename,
            filters: [{ name: ext.toUpperCase(), extensions: [ext] }],
          });
          if (!filePath) return Option.none<string>();

          if (typeof content === 'string') {
            await writeTextFile(filePath, content);
          } else {
            await writeFile(filePath, new Uint8Array(content as ArrayBuffer));
          }
          return Option.some(filePath);
        },
        catch: (cause) => new PlatformError({ operation: 'saveFile', cause }),
      });

    return {
      ask: dialogAsk,
      selectDirectory,
      selectFiles,
      saveFile,
    } satisfies DialogShape;
  }),
);
