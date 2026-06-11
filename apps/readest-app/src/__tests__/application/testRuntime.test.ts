import { Effect } from 'effect';
import { describe, expect, it } from 'vitest';
import { testRuntime } from '@/runtime/test';
import { Platform } from '@/application/ports/Platform';
import { FileSystem } from '@/application/ports/FileSystem';
import { PathResolver } from '@/application/ports/PathResolver';
import { PathState } from '@/application/ports/PathState';
import { BootApp } from '@/application/usecases/boot/BootApp';

describe('testRuntime', () => {
  it('provides Platform, PathState, PathResolver, FileSystem together', async () => {
    const result = await testRuntime.runPromise(
      Effect.gen(function* () {
        const platform = yield* Platform;
        const info = yield* platform.info;
        const state = yield* PathState;
        yield* state.set({ customRootDir: '/r', isPortable: false });
        const resolver = yield* PathResolver;
        const abs = yield* resolver.absolute('book.epub', 'Books');
        const fs = yield* FileSystem;
        yield* fs.writeFile('book.epub', 'Books', 'data');
        const back = yield* fs.readFile('book.epub', 'Books', 'text');
        return { platform: info.appPlatform, abs, back };
      }),
    );
    expect(result).toEqual({ platform: 'web', abs: '/r/Books/book.epub', back: 'data' });
  });

  it('runs BootApp through the wired SettingsRepository + MigrationService', async () => {
    const result = await testRuntime.runPromise(
      Effect.gen(function* () {
        const { platform, settings } = yield* BootApp;
        return { appPlatform: platform.appPlatform, hasSettings: !!settings };
      }),
    );
    expect(result.appPlatform).toBe('web');
    expect(result.hasSettings).toBe(true);
  });
});
