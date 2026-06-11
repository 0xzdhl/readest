# E5a — Final consumer migration off appService Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove all business-logic dependence on `useEnv().appService` by migrating every consumer onto the existing Effect bridge — `usePlatformInfo()`/`getPlatformInfo()` for platform flags, ports/usecases for IO — leaving the god-objects alive but unreferenced-by-behavior (E5b deletes them).

**Architecture:** Additive consumer migration, no new infrastructure. Component A = a mechanical ~67-file platform-flag sweep (`appService?.<flag>` → `platformInfo.<flag>`, identical names) grouped by directory subtree. Component B = ~12 IO-method files mapped to ports/usecases. Component C = non-React flag readers + trivial param-drops. The tree stays green/bootable throughout (legacy boot still runs).

**Tech Stack:** TypeScript (ES2022, strict, no `any`), Effect, React, Zustand, Vitest.

**Spec:** `docs/superpowers/specs/2026-06-10-effect-e5a-consumer-migration-design.md`

**Conventions:**

- React component/hook: `const platformInfo = usePlatformInfo();` (from `@/context/EffectRuntimeProvider`) then `platformInfo.<flag>`. For IO: `const runEffect = useRunEffect();` then `await runEffect(Effect.flatMap(<Port>, (x) => x.<method>(...)))`.
- Non-React module/class: `getPlatformInfo()` (from `@/runtime/clientRuntime`) for flags; `getClientRuntime().runPromise(Effect.flatMap(<Port>, …))` for IO.
- **Flag names are IDENTICAL** between the legacy `AppService` interface and `PlatformInfo` (verified: both use `supportsCanvasContext2DFilter`, `isAndroidApp`, `hasRoundedWindow`, etc.). The sweep is a rename-free `appService?.X` → `platformInfo.X`. The only semantic change: `appService?.X` was `undefined` until async boot; `platformInfo.X` is always defined (sync, SSR-safe) — faithful-or-better.
- Ports (all exist): `SettingsRepository`{load,save} (`@/application/repositories/SettingsRepository`), `LibraryRepository`{load,save} (`…/repositories/LibraryRepository`), `BookRepository` (`…/repositories/BookRepository`), `CloudService` (`@/application/services/CloudService`), `FileSystem`/`PathResolver`/`Dialog`/`Platform` (`@/application/ports/*`), `importBooks` usecase (`@/application/usecases/book`).

**Verify after every task that touches code:** `npx tsgo --noEmit 2>&1 | grep -v upload-cjk-fonts-r2 | grep 'error TS'` → empty. Full `pnpm test` at the end.

**Execution note (parallel sweep):** Component-A tasks touch DISJOINT file sets, so they are parallel-safe to EDIT. To avoid `git index.lock` races, if dispatching A-tasks concurrently, have each subagent only EDIT + run tsgo on its subtree and report the file list; the orchestrator commits each subtree sequentially. If running sequentially, each A-task commits its own subtree.

---

## Component A — Platform-flag sweep

**The canonical transformation (applies to every flag-only file in A):**

1. If the file does `const { appService } = useEnv();` (or `const { envConfig, appService } = useEnv();`): replace with `const platformInfo = usePlatformInfo();` (keep `envConfig`/other destructured names if still used; drop `appService`). Add `import { usePlatformInfo } from '@/context/EffectRuntimeProvider';`. If `useEnv` is now unused, remove its import.
2. Replace every `appService?.<flag>` and `appService.<flag>` with `platformInfo.<flag>` (same flag name). Flags in scope: `appPlatform, osPlatform, distChannel, storefrontRegionCode, hasTrafficLight, hasWindow, hasWindowBar, hasContextMenu, hasRoundedWindow, hasSafeAreaInset, hasHaptics, hasUpdater, hasOrientationLock, hasScreenBrightness, hasIAP, isMobile, isAppDataSandbox, isMobileApp, isAndroidApp, isIOSApp, isMacOSApp, isLinuxApp, isPortableApp, isDesktopApp, isAppImage, isEink, canCustomizeRootDir, canReadExternalDir, supportsCanvasContext2DFilter, isOnlineCatalogsAccessible`.
3. Fix `useEffect`/`useMemo`/`useCallback` dependency arrays: remove `appService` (and `appService?.X`) entries. `platformInfo` is a stable sync value — it does NOT need to be added to deps (it never changes within a session). Remove stale `appService` deps; do not add `platformInfo`.
4. Non-React module/class files (no hooks): use `getPlatformInfo()` instead of `usePlatformInfo()`, called at the point of use (or once at function top).
5. **Do NOT touch the Component-B/C files** (listed below) — they are owned by their own tasks. If a file in your subtree is on the exclusion list, skip it entirely.

**Exclusion list (owned by B/C/E5b — never edit in an A-task):**
`app/library/index.tsx`, `app/opds/index.tsx`, `app/user/components/StorageManager.tsx`, `app/reader/components/annotator/Annotator.tsx`, `app/reader/components/sidebar/SearchBar.tsx`, `app/library/components/BookshelfItem.tsx`, `app/library/components/ShareBookDialog.tsx`, `hooks/useFileSelector.ts`, `hooks/useLibrary.ts`, `hooks/useOPDSSubscriptions.ts`, `services/opds/autoDownload.ts`, `components/Providers.tsx`, `context/EffectRuntimeProvider.tsx`, `context/EnvContext.tsx`, `services/tts/TTSController.ts`, `services/tts/EdgeTTSClient.ts`, `app/reader/hooks/useTTSControl.ts`, `store/trafficLightStore.ts`, `hooks/useTrafficLight.ts`, `helpers/openWith.ts`, `services/hardcover/HardcoverSyncMapStore.ts`, `app/reader/hooks/useHardcoverSync.ts`, `components/settings/integrations/HardcoverForm.tsx`, `hooks/useReplicaPull.ts`, `hooks/useDiscordPresence.ts` (already migrated; leave its readiness usage), `utils/discord.ts`, `utils/misc.ts`.

**Worked example (representative — `app/reader/components/ViewMenu.tsx`):**

```tsx
// before:
const { appService } = useEnv();
// ... later ...
{bookData.book?.format === 'PDF' && appService?.supportsCanvasContext2DFilter && ( … )}

// after:
const platformInfo = usePlatformInfo();
// ... later ...
{bookData.book?.format === 'PDF' && platformInfo.supportsCanvasContext2DFilter && ( … )}
```

### Task A1: reader subtree, part 1 — `src/app/reader/components/*.tsx` (top-level)

**Files:** all flag-only `.tsx` directly under `src/app/reader/components/` (e.g. `Reader.tsx`, `HeaderBar.tsx`, `FoliateViewer.tsx`, `ViewMenu.tsx`, `SectionInfo.tsx`, `ProgressBar.tsx`, `PageNavigationButtons.tsx`, `ReaderContent.tsx`, `TranslationToggler.tsx`, `NotebookToggler.tsx`, `HintInfo.tsx`, `BooksGrid.tsx`) — EXCLUDING the exclusion list.

- [ ] **Step 1: Enumerate the subtree's flag-only files.**

Run: `grep -rlE 'appService(\?\.|\.)' src/app/reader/components --include=*.tsx --maxdepth 1 2>/dev/null | grep -v '__tests__'`
(Then exclude any on the exclusion list: `annotator/`, `sidebar/` are separate subdirs handled in A2; only the top-level files here.)

- [ ] **Step 2: Apply the canonical transformation** to each file (steps 1–4 above). For each: swap `useEnv().appService` → `usePlatformInfo()`, `appService?.<flag>` → `platformInfo.<flag>`, clean dep arrays.

- [ ] **Step 3: Verify subtree types.**

Run: `npx tsgo --noEmit 2>&1 | grep -v upload-cjk-fonts-r2 | grep 'error TS'`
Expected: empty.

- [ ] **Step 4: Grep-gate the subtree.**

Run: `grep -rn 'appService' src/app/reader/components/*.tsx`
Expected: no matches (all top-level reader components migrated; subdirs are A2).

- [ ] **Step 5: Commit.**

```bash
git add src/app/reader/components/*.tsx
git commit -m "refactor(effect): sweep reader top-level components to usePlatformInfo (E5a)"
```

### Task A2: reader subtree, part 2 — `src/app/reader/{components/sidebar,components/footerbar,components/annotator,components/paragraph,components/tts,components/notebook}` + `src/app/reader/hooks` + `src/app/reader/*.tsx`

**Files:** all flag-only files under those reader subdirs + `src/app/reader/hooks/*` + `src/app/reader/ReaderRoutePage.tsx`, EXCLUDING exclusion-list files (`annotator/Annotator.tsx`, `sidebar/SearchBar.tsx`, `hooks/useTTSControl.ts`, `hooks/useHardcoverSync.ts`).

- [ ] **Step 1: Enumerate.**

Run: `grep -rlE 'appService(\?\.|\.)' src/app/reader/components/sidebar src/app/reader/components/footerbar src/app/reader/components/annotator src/app/reader/components/paragraph src/app/reader/components/tts src/app/reader/components/notebook src/app/reader/hooks src/app/reader --include=*.ts --include=*.tsx 2>/dev/null | grep -v '__tests__' | grep -vE 'annotator/Annotator|sidebar/SearchBar|useTTSControl|useHardcoverSync|reader/components/[A-Za-z]+\.tsx$'`

(The last exclusion avoids re-touching A1's top-level files.)

- [ ] **Step 2: Apply the canonical transformation** to each. Note `usePagination.ts`/`useTextSelector.ts`/`useKeyDownActions.ts` are hooks → `usePlatformInfo()`.

- [ ] **Step 3: Verify + grep-gate + commit.**

Run: `npx tsgo --noEmit 2>&1 | grep -v upload-cjk-fonts-r2 | grep 'error TS'` → empty.
Run: `grep -rn 'appService' src/app/reader/components/{sidebar,footerbar,annotator,paragraph,tts,notebook} src/app/reader/hooks src/app/reader/*.tsx | grep -v 'Annotator.tsx\|SearchBar.tsx\|useTTSControl\|useHardcoverSync'` → empty.

```bash
git add src/app/reader
git commit -m "refactor(effect): sweep reader sidebar/footerbar/annotator/hooks to usePlatformInfo (E5a)"
```

### Task A3: `src/app/library/components/*` + `src/app/opds/components/*` + `src/app/user/components/*`

**Files:** flag-only files under those dirs, EXCLUDING `library/components/BookshelfItem.tsx`, `library/components/ShareBookDialog.tsx`, `user/components/StorageManager.tsx`, and `library/index.tsx`/`opds/index.tsx` (B).

- [ ] **Step 1: Enumerate.**

Run: `grep -rlE 'appService(\?\.|\.)' src/app/library/components src/app/opds src/app/user --include=*.ts --include=*.tsx 2>/dev/null | grep -v '__tests__' | grep -vE 'BookshelfItem|ShareBookDialog|StorageManager|library/index|opds/index'`

- [ ] **Step 2: Apply the canonical transformation.**

- [ ] **Step 3: Verify + grep-gate + commit.**

Run tsgo (empty). Run: `grep -rn 'appService' src/app/library/components src/app/opds/components src/app/user/components | grep -vE 'BookshelfItem|ShareBookDialog|StorageManager'` → empty.

```bash
git add src/app/library/components src/app/opds src/app/user
git commit -m "refactor(effect): sweep library/opds/user components to usePlatformInfo (E5a)"
```

### Task A4: `src/components/**`

**Files:** flag-only files under `src/components/` (`Auth.tsx`, `Dialog.tsx`, `WindowButtons.tsx`, `AboutWindow.tsx`, `AppLockScreen.tsx`, `LegalLinks.tsx`, `command-palette/CommandPaletteProvider.tsx`, `settings/ControlPanel.tsx`, `settings/LayoutPanel.tsx`, `settings/MiscPanel.tsx`, `settings/SettingsDialog.tsx`, `settings/integrations/KOSyncForm.tsx`), EXCLUDING `Providers.tsx` (B-residual/E5b).

- [ ] **Step 1: Enumerate.**

Run: `grep -rlE 'appService(\?\.|\.)' src/components --include=*.ts --include=*.tsx 2>/dev/null | grep -v '__tests__' | grep -vE 'components/Providers\.tsx'`

- [ ] **Step 2: Apply the canonical transformation.** (`SettingsDialog.tsx` already carries the pre-existing unused-`lazy` biome error — do NOT try to fix that; leave it. Just migrate its appService flags.)

- [ ] **Step 3: Verify + grep-gate + commit.**

tsgo empty. `grep -rn 'appService' src/components | grep -v 'Providers.tsx'` → empty.

```bash
git add src/components
git commit -m "refactor(effect): sweep components/ to usePlatformInfo (E5a)"
```

### Task A5: `src/hooks/**` + `src/utils/**` (flag-only)

**Files:** flag-only files under `src/hooks/` (`useTheme.ts`, `useKeyDownActions.ts`, `useSwipeToDismiss.ts`, `useOpenWithBooks.ts`, `useAppUrlIngress.ts`, `useWindowActiveChanged.ts`) + `src/utils/misc.ts` if it reads a flag. EXCLUDING `useFileSelector.ts`, `useLibrary.ts`, `useOPDSSubscriptions.ts`, `useReplicaPull.ts`, `useTrafficLight.ts`, `useDiscordPresence.ts`, `utils/discord.ts`.

- [ ] **Step 1: Enumerate.**

Run: `grep -rlE 'appService(\?\.|\.)' src/hooks src/utils --include=*.ts --include=*.tsx 2>/dev/null | grep -v '__tests__' | grep -vE 'useFileSelector|useLibrary\.ts|useOPDSSubscriptions|useReplicaPull|useTrafficLight|useDiscordPresence|utils/discord'`

- [ ] **Step 2: Apply the canonical transformation.** Check `utils/misc.ts`: if its `appService` ref is a non-React helper, use `getPlatformInfo()`; if it only appears in a comment, leave it.

- [ ] **Step 3: Verify + grep-gate + commit.**

tsgo empty. `grep -rn 'appService' src/hooks src/utils | grep -vE 'useFileSelector|useLibrary\.ts|useOPDSSubscriptions|useReplicaPull|useTrafficLight|useDiscordPresence|discord'` → empty.

```bash
git add src/hooks src/utils
git commit -m "refactor(effect): sweep hooks/utils flag readers to usePlatformInfo (E5a)"
```

---

## Component B — IO/data consumers

Each file: swap platform flags → `usePlatformInfo()` (same as A) AND map IO/data calls to ports. Mapping table:

| `appService.<m>`                                                        | replacement                                                                                                                                                                           |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- | --------- | ------ | --------- | -------- | ------------------- |
| `loadSettings()`                                                        | `runEffect(Effect.flatMap(SettingsRepository, (r) => r.load))` (property — no parens on `.load`)                                                                                      |
| `loadLibraryBooks()`                                                    | `runEffect(Effect.flatMap(LibraryRepository, (r) => r.load))`                                                                                                                         |
| `saveLibraryBooks(b)`                                                   | `runEffect(Effect.flatMap(LibraryRepository, (r) => r.save(b)))`                                                                                                                      |
| `isBookAvailable(book)`                                                 | `runEffect(Effect.flatMap(BookRepository, (r) => r.isAvailable(book)))`                                                                                                               |
| `getBookFileSize(book)`                                                 | `runEffect(Effect.flatMap(BookRepository, (r) => r.getFileSize(book)))`                                                                                                               |
| `deleteBook(book, action)`                                              | `runEffect(Effect.flatMap(CloudService, (c) => c.deleteBook(book, action)))`                                                                                                          |
| `downloadReplicaFile(...)`                                              | `runEffect(Effect.flatMap(CloudService, (c) => c.downloadReplicaFile({...})))` (opts object — see CloudService shape)                                                                 |
| `importBook(path, books, opts?)`                                        | `importBooks` usecase (`importBooksUsecase(books, [{ file: path }], { persist: false, ...opts })` → read `imported[0]`; match the E4 precedent in `shareImport.ts`/`autoDownload.ts`) |
| `selectFiles(name, exts)`                                               | `runEffect(Effect.flatMap(Dialog, (d) => d.selectFiles(name, exts)))` → `readonly string[]`                                                                                           |
| `selectDirectory(mode)`                                                 | `runEffect(Effect.flatMap(Dialog, (d) => d.selectDirectory(mode)))` → `Option<string>` (use `Option.getOrElse`/`Option.isSome`)                                                       |
| `saveFile(name, data, opts)`                                            | `runEffect(Effect.flatMap(Dialog, (d) => d.saveFile(name, data, opts)))` → `Option<string>`                                                                                           |
| `readFile/readDirectory/writeFile/exists/createDir/copyFile/removeFile` | `runEffect(Effect.flatMap(FileSystem, (fs) => fs.<readFile                                                                                                                            | readDir | writeFile | exists | createDir | copyFile | removeFile>(...)))` |
| `getImageURL(path)`                                                     | `runEffect(Effect.flatMap(FileSystem, (fs) => fs.getUrl(path)))` OR `getClientRuntime().runSync(...)` (sync port) in non-React                                                        |
| `resolveFilePath(p, base)`                                              | `runEffect(Effect.flatMap(PathResolver, (r) => r.absolute(p, base)))`                                                                                                                 |

Before migrating each B file, read it fully and grep its exact `appService` sites: `grep -n 'appService' <file>`.

### Task B1: `src/hooks/useLibrary.ts`

**Files:** Modify `src/hooks/useLibrary.ts`.

Current `initLibrary` (lines ~27-33) does `const appService = await envConfig.getAppService(); const settings = await appService.loadSettings(); setSettings(settings); setLibrary(await runEffect(Effect.flatMap(LibraryRepository, (r) => r.load)));`. The `LibraryRepository.load` is already migrated.

- [ ] **Step 1:** Add `import { SettingsRepository } from '@/application/repositories/SettingsRepository';`. Replace the two `appService` lines:

```ts
// was: const appService = await envConfig.getAppService();
//      const settings = await appService.loadSettings();
const settings = await runEffect(Effect.flatMap(SettingsRepository, (r) => r.load));
setSettings(settings);
```

- [ ] **Step 2:** `envConfig` is now unused → remove it from `const { envConfig } = useEnv();` (and the `useEnv` import if fully unused — it is, since only `envConfig` was destructured).

- [ ] **Step 3: Verify + commit.**

Run: `grep -n 'appService\|envConfig\|getAppService' src/hooks/useLibrary.ts` → empty. tsgo empty.

```bash
git add src/hooks/useLibrary.ts
git commit -m "refactor(effect): useLibrary loadSettings via SettingsRepository (E5a)"
```

### Task B2: `src/hooks/useFileSelector.ts` + caller

**Files:** Modify `src/hooks/useFileSelector.ts`, `src/app/library/index.tsx` (caller line ~140 — but library/index is migrated in B6; just update the `useFileSelector(...)` call there as part of B6).

`selectFileTauri(options, appService, _)` uses `appService?.isIOSApp`, `appService?.isAndroidApp`, `appService?.selectFiles(...)`. `useFileSelector(appService, _)` has `if (!appService) return error`.

- [ ] **Step 1:** Change `selectFileTauri`'s signature to `(options, _)` (drop `appService`). Use `getPlatformInfo()` for flags, `getClientRuntime().runPromise(Effect.flatMap(Dialog, (d) => d.selectFiles(_(title), exts)))` for selectFiles. Imports: `getPlatformInfo`, `getClientRuntime` from `@/runtime/clientRuntime`; `Effect` from `effect`; `Dialog` from `@/application/ports/Dialog`.

```ts
const selectFileTauri = async (
  options: FileSelectorOptions,
  _: (key: string) => string,
): Promise<string[]> => {
  const platformInfo = getPlatformInfo();
  const noFilter =
    platformInfo.isIOSApp ||
    (platformInfo.isAndroidApp && (options.type === 'books' || options.type === 'dictionaries'));
  const exts = noFilter ? [] : options.extensions || [];
  const title = options.dialogTitle || _('Select Files');
  let files: string[] = [
    ...(await getClientRuntime().runPromise(
      Effect.flatMap(Dialog, (d) => d.selectFiles(_(title), exts)),
    )),
  ];
  if (noFilter && options.extensions) {
    files = await Promise.all(
      files.map(async (file: string) => {
        let processedFile = file;
        if (platformInfo.isAndroidApp && file.startsWith('content://')) {
          processedFile = await basename(file);
        }
        const fileExt = processedFile.split('.').pop()?.toLowerCase() || 'unknown';
        const extensions = options.extensions!;
        const shouldInclude = extensions.includes(fileExt) || extensions.includes('*');
        return shouldInclude ? file : null;
      }),
    ).then((results) => results.filter((file): file is string => file !== null));
  }
  return files;
};
```

(Note the `[...(await … selectFiles)]` spread converts `readonly string[]` → mutable `string[]`.)

- [ ] **Step 2:** Change `useFileSelector(appService, _)` → `useFileSelector(_)`. Remove the `if (!appService) return { files: [], error: 'App service is not available' };` guard (the runtime is always available). Update the `selectFileTauri(options, appService, _)` call → `selectFileTauri(options, _)`. Remove the `import type { AppService }`.

- [ ] **Step 3: Verify.**

Run: `grep -n 'appService' src/hooks/useFileSelector.ts` → empty. tsgo empty. (The caller in `library/index.tsx:140` `useFileSelector(appService, _)` will momentarily mistype — fix it now to `useFileSelector(_)` even though library/index is fully migrated in B6; this one-line caller change keeps tsgo green.)

- [ ] **Step 4: Commit.**

```bash
git add src/hooks/useFileSelector.ts src/app/library/index.tsx
git commit -m "refactor(effect): useFileSelector via Dialog.selectFiles + usePlatformInfo (E5a)"
```

### Task B3: `src/app/user/components/StorageManager.tsx`

**Files:** Modify `src/app/user/components/StorageManager.tsx`.

- [ ] **Step 1:** Read it: `grep -n 'appService' src/app/user/components/StorageManager.tsx`. Map each call per the table (it has 1 IO call + possibly flags). Migrate flags → `usePlatformInfo()`, the IO call → its port.

- [ ] **Step 2: Verify + commit.**

`grep -n 'appService' src/app/user/components/StorageManager.tsx` → empty (or only readiness). tsgo empty.

```bash
git add src/app/user/components/StorageManager.tsx
git commit -m "refactor(effect): StorageManager off appService (E5a)"
```

### Task B4: `src/app/reader/components/annotator/Annotator.tsx` + `src/app/reader/components/sidebar/SearchBar.tsx`

**Files:** Modify both.

- [ ] **Step 1:** For each, `grep -n 'appService' <file>` and map per the table (these have flags + IO). Migrate flags → `usePlatformInfo()`, IO → ports.

- [ ] **Step 2: Verify + commit.**

`grep -n 'appService' src/app/reader/components/annotator/Annotator.tsx src/app/reader/components/sidebar/SearchBar.tsx` → empty. tsgo empty.

```bash
git add src/app/reader/components/annotator/Annotator.tsx src/app/reader/components/sidebar/SearchBar.tsx
git commit -m "refactor(effect): Annotator + SearchBar off appService (E5a)"
```

### Task B5: `src/app/library/components/BookshelfItem.tsx` + `src/app/library/components/ShareBookDialog.tsx` + `src/hooks/useOPDSSubscriptions.ts`

**Files:** Modify the three.

- [ ] **Step 1:** `BookshelfItem.tsx` — map its IO calls + flags. `ShareBookDialog.tsx` — residual from E4: it keeps `getBookFileSize` (→ `BookRepository.getFileSize`) + `isMobileApp`/`hasWindow` flags (→ `usePlatformInfo()`); the upload already uses CloudService. `useOPDSSubscriptions.ts` — its 1 remaining `appService` ref is a readiness/guard from E4; if it's `if (!appService)` keep it for E5b, else migrate. `grep -n 'appService' <file>` each first.

- [ ] **Step 2: Verify + commit.**

`grep -n 'appService' src/app/library/components/BookshelfItem.tsx src/app/library/components/ShareBookDialog.tsx src/hooks/useOPDSSubscriptions.ts` → only readiness guards (if any). tsgo empty.

```bash
git add src/app/library/components/BookshelfItem.tsx src/app/library/components/ShareBookDialog.tsx src/hooks/useOPDSSubscriptions.ts
git commit -m "refactor(effect): BookshelfItem/ShareBookDialog/useOPDSSubscriptions off appService (E5a)"
```

### Task B6: `src/app/library/index.tsx` (the heaviest — flags + many IO + internal helpers)

**Files:** Modify `src/app/library/index.tsx`. Depends on B2 (useFileSelector signature) and C-tasks (openWith). Do this AFTER A3/B2/C-openWith.

This file has ~22 `appService` reads: flags (`isAndroidApp`/`hasUpdater`/`isMobileApp`/`hasWindow`/`isMobile`/`hasHaptics`/`isLinuxApp`/`hasRoundedWindow`) + IO (`loadSettings`/`loadLibraryBooks`/`isBookAvailable`/`deleteBook`/`selectDirectory`/`readDirectory`) + 3 `getAppService()` blocks + internal helpers (`processOpenWithFiles(appService,...)`, `handleOpenWithBooks(appService,...)`, `handleOpenLastBooks(appService,...)`, `parseOpenWithFiles(appService)`).

- [ ] **Step 1: Read the whole file** and grep: `grep -n 'appService' src/app/library/index.tsx`.

- [ ] **Step 2: Flags** → `usePlatformInfo()` (the file already has `useRunEffect`; add `usePlatformInfo`). Lines ~307/312/314/323/326/329/332/886/916/928. **Keep the readiness gate `if (!appService || …)` at ~915** (E5b owns it) but swap the `appService?.isLinuxApp` flag inside the returned `<div>` className (~916) to `platformInfo.isLinuxApp`.

- [ ] **Step 3: getAppService blocks** (~340, ~469, ~487): replace `const appService = await envConfig.getAppService(); const settings = await appService.loadSettings();` with `const settings = await runEffect(Effect.flatMap(SettingsRepository, (r) => r.load));` and `appService.loadLibraryBooks()` with `runEffect(Effect.flatMap(LibraryRepository, (r) => r.load))`.

- [ ] **Step 4: Internal helpers.** Drop the `appService: AppService` param from `processOpenWithFiles`/`handleOpenWithBooks`/`handleOpenLastBooks` and route their inner calls: `appService.loadSettings()`→SettingsRepository, `appService.isMobile`→`platformInfo.isMobile`, `appService.isBookAvailable(book)`→BookRepository, `parseOpenWithFiles(appService)`→`parseOpenWithFiles()` (C-openWith dropped the param), `importBook`→`importBooks` usecase. Update their call sites (drop the `appService` arg).

- [ ] **Step 5: Other IO:** `appService?.deleteBook(book, 'local')` (~769) → `runEffect(Effect.flatMap(CloudService, (c) => c.deleteBook(book, 'local')))`; `appService.selectDirectory?.('read')` (~861) → `runEffect(Effect.flatMap(Dialog, (d) => d.selectDirectory('read')))` (returns `Option<string>` — adapt the `if (selectedDir)` check via `Option.getOrUndefined`); `appService.readDirectory(importDirectory, 'None')` (~869) → `runEffect(Effect.flatMap(FileSystem, (fs) => fs.readDir(importDirectory, 'None')))`. Line ~850 `if (!appService || !isTauriAppPlatform()) return;` → keep `!isTauriAppPlatform()` (drop `!appService`, since the readiness gate above already guarantees boot) OR leave `!appService` (it's still provided) — prefer dropping `!appService` here since this is a behavioral guard, not the render gate.

- [ ] **Step 6: `useFileSelector(appService, _)` (~140)** → `useFileSelector(_)` (done in B2; confirm).

- [ ] **Step 7: Remove unused `import type { AppService }`** if all its uses are gone (the helper param types). Keep `appService` from `useEnv()` ONLY if the readiness gate at ~915 still needs it — it does (`if (!appService)`), so keep `const { appService } = useEnv()` for that one guard; remove `envConfig` if now unused.

- [ ] **Step 8: Verify.**

Run: `grep -n 'appService' src/app/library/index.tsx`
Expected: ONLY the readiness gate `if (!appService …)` at ~915 (and the `const { appService } = useEnv()` feeding it). NO flag reads, NO IO calls, NO `getAppService()`.
Run tsgo → empty.

- [ ] **Step 9: Commit.**

```bash
git add src/app/library/index.tsx
git commit -m "refactor(effect): migrate library/index IO + flags off appService (E5a)"
```

### Task B7: `src/app/opds/index.tsx`

**Files:** Modify `src/app/opds/index.tsx` (9 appService reads — flags + residual; E4 already did its `deleteFile`).

- [ ] **Step 1:** `grep -n 'appService' src/app/opds/index.tsx`. Migrate flags → `usePlatformInfo()`, any remaining IO → ports. Keep any `if (!appService)` readiness guard for E5b.

- [ ] **Step 2: Verify + commit.**

`grep -n 'appService' src/app/opds/index.tsx` → only readiness guard (if any). tsgo empty.

```bash
git add src/app/opds/index.tsx
git commit -m "refactor(effect): migrate opds/index flags + residual off appService (E5a)"
```

---

## Component C — Non-React flag readers + trivial drops

### Task C1: TTS — `TTSController` + `EdgeTTSClient` + `useTTSControl`

**Files:** Modify `src/services/tts/TTSController.ts`, `src/services/tts/EdgeTTSClient.ts`, `src/app/reader/hooks/useTTSControl.ts`.

- [ ] **Step 1: `EdgeTTSClient.ts`** — drop the `appService` ctor param + the `appService?: AppService | null` field. Replace `this.appService?.isLinuxApp` (lines ~209/215) with `getPlatformInfo().isLinuxApp`. Add `import { getPlatformInfo } from '@/runtime/clientRuntime';`. Remove `import type { AppService }`.

```ts
// ctor:
constructor(controller?: TTSController) {
  this.controller = controller;
}
// lines ~209/215:
if (!getPlatformInfo().isLinuxApp) { audio.playbackRate = this.#rate; }
// ...
if (getPlatformInfo().isLinuxApp) { audio.playbackRate = this.#rate; }
```

- [ ] **Step 2: `TTSController.ts`** — drop the `appService: AppService | null` ctor param + the `appService: AppService | null = null;` field + `this.appService = appService;` assignment. Replace `new EdgeTTSClient(this, appService)` → `new EdgeTTSClient(this)`; `appService?.isAndroidApp` (line ~63) → `getPlatformInfo().isAndroidApp`. Add `import { getPlatformInfo } from '@/runtime/clientRuntime';`. Remove `import type { AppService }`.

- [ ] **Step 3: `useTTSControl.ts:510`** — `new TTSController(appService, view, !!user?.id, …)` → `new TTSController(view, !!user?.id, …)`. Also migrate `appService?.isIOSApp` (~500) and `appService?.isMobile` (~503) → `usePlatformInfo()`. If `appService` becomes unused in the hook, drop it from `useEnv()`.

- [ ] **Step 4: Verify.**

Run: `grep -n 'appService' src/services/tts/TTSController.ts src/services/tts/EdgeTTSClient.ts` → empty. `grep -n 'appService' src/app/reader/hooks/useTTSControl.ts` → empty (or readiness only). tsgo empty.

- [ ] **Step 5: Tests.** TTS tests (`src/__tests__/**edge*tts*`, `useTTSControl` tests) likely construct `new TTSController(fakeAppService, …)` / `new EdgeTTSClient(_, fakeAppService)`. Drop the arg; mock `@/runtime/clientRuntime`'s `getPlatformInfo` for the `isLinuxApp`/`isAndroidApp` paths (copy the E1 store-test pattern). Run them: `npx vitest run src/__tests__/libs/edgeTTS.test.ts <other tts tests>` (edgeTTS is env-flaky on timeout — focus on the ctor-signature + isLinuxApp assertions passing).

- [ ] **Step 6: Commit.**

```bash
git add src/services/tts/TTSController.ts src/services/tts/EdgeTTSClient.ts src/app/reader/hooks/useTTSControl.ts <tts tests>
git commit -m "refactor(effect): TTS clients use getPlatformInfo, drop appService (E5a)"
```

### Task C2: `trafficLightStore` + `useTrafficLight`

**Files:** Modify `src/store/trafficLightStore.ts`, `src/hooks/useTrafficLight.ts`.

- [ ] **Step 1: `trafficLightStore.ts`** — remove `appService?: AppService;` from `TrafficLightState`. Change `initializeTrafficLightStore: (appService: AppService) => void` → `initializeTrafficLightStore: () => void`. In the impl, drop `appService` from the `set({...})` and use `getPlatformInfo().hasTrafficLight`:

```ts
initializeTrafficLightStore: () => {
  const hasTrafficLight = getPlatformInfo().hasTrafficLight;
  set({ isTrafficLightVisible: hasTrafficLight, shouldShowTrafficLight: hasTrafficLight });
},
```

Add `import { getPlatformInfo } from '@/runtime/clientRuntime';`. Remove `import type { AppService }`.

- [ ] **Step 2: `useTrafficLight.ts:19`** — `initializeTrafficLightStore(appService)` → `initializeTrafficLightStore()`. Remove `appService` from `useEnv()` if now unused.

- [ ] **Step 3: Verify + commit.**

`grep -n 'appService' src/store/trafficLightStore.ts src/hooks/useTrafficLight.ts` → empty. tsgo empty.

```bash
git add src/store/trafficLightStore.ts src/hooks/useTrafficLight.ts
git commit -m "refactor(effect): trafficLightStore hasTrafficLight via getPlatformInfo (E5a)"
```

### Task C3: `openWith` + caller

**Files:** Modify `src/helpers/openWith.ts`. (Caller is `library/index.tsx` — handled in B6.)

- [ ] **Step 1:** Drop the `appService: AppService | null` param from `parseIntentOpenWithFiles` and `parseOpenWithFiles`. Replace `appService?.isIOSApp` (line ~46) with `getPlatformInfo().isIOSApp`. Add `import { getPlatformInfo } from '@/runtime/clientRuntime';`. Remove `import type { AppService }`.

```ts
const parseIntentOpenWithFiles = async () => {
  const urls = await getCurrent();
  // ... if (getPlatformInfo().isIOSApp) { return decodeURI(url); } ...
};
export const parseOpenWithFiles = async () => {
  if (isWebAppPlatform()) return [];
  // ...
  if (!files || files.length === 0) {
    files = await parseIntentOpenWithFiles();
  }
  return files;
};
```

- [ ] **Step 2: Verify + commit.**

`grep -n 'appService' src/helpers/openWith.ts` → empty. tsgo empty. (Caller fix lands in B6; if doing C3 before B6, tsgo will flag the `parseOpenWithFiles(appService)` call site — that's expected and B6 fixes it. To keep each commit green, do C3 immediately before B6, or fix the single call site here.)

```bash
git add src/helpers/openWith.ts
git commit -m "refactor(effect): openWith uses getPlatformInfo, drop appService param (E5a)"
```

### Task C4: `HardcoverSyncMapStore` + `useHardcoverSync` + `HardcoverForm`

**Files:** Modify `src/services/hardcover/HardcoverSyncMapStore.ts`, `src/app/reader/hooks/useHardcoverSync.ts`, `src/components/settings/integrations/HardcoverForm.tsx`.

- [ ] **Step 1: `HardcoverSyncMapStore.ts`** — delete the `constructor(_appService: AppService) {}` entirely (it's already a no-op; an empty `constructor()` is a useless-constructor biome error, so remove it, not just empty it). Remove the `import type { AppService }` + the biome-ignore comment.

- [ ] **Step 2: `useHardcoverSync.ts:33`** — `const appService = await envConfig.getAppService(); const mapStore = new HardcoverSyncMapStore(appService);` → `const mapStore = new HardcoverSyncMapStore();`. Remove the `getAppService()` line. If `envConfig` is now unused in the hook (check the other `[envConfig]` deps/uses), remove it.

- [ ] **Step 3: `HardcoverForm.tsx:28`** — same: `const mapStore = new HardcoverSyncMapStore();`. Remove the `getAppService()` line + unused `envConfig`.

- [ ] **Step 4: Verify.**

Run: `grep -n 'appService\|getAppService' src/services/hardcover/HardcoverSyncMapStore.ts src/app/reader/hooks/useHardcoverSync.ts src/components/settings/integrations/HardcoverForm.tsx` → empty. tsgo empty.

- [ ] **Step 5: Tests.** `HardcoverSyncMapStore` tests construct `new HardcoverSyncMapStore(fakeAppService)` → drop the arg. Run: `npx vitest run src/__tests__/**HardcoverSyncMapStore* src/__tests__/**hardcover*` (hardcover is env-flaky; ensure the ctor change passes).

- [ ] **Step 6: Commit.**

```bash
git add src/services/hardcover/HardcoverSyncMapStore.ts src/app/reader/hooks/useHardcoverSync.ts src/components/settings/integrations/HardcoverForm.tsx <hardcover tests>
git commit -m "refactor(effect): drop unused appService from HardcoverSyncMapStore + callers (E5a)"
```

### Task C5: `useReplicaPull`

**Files:** Modify `src/hooks/useReplicaPull.ts` (+ any caller passing `appService`).

- [ ] **Step 1:** `grep -n 'appService\|AppService' src/hooks/useReplicaPull.ts` and read the surrounding code. The `AppService`-typed params have no method calls (pass-through). Remove the param from the affected fn signatures + internal threading; update call sites to drop the `appService` arg. Remove `import type { AppService }`.

- [ ] **Step 2: Verify + commit.**

`grep -n 'appService\|AppService' src/hooks/useReplicaPull.ts` → empty. tsgo empty. Run its test: `npx vitest run src/__tests__/**replica*ull* 2>&1 | tail -5` (rebridge if it injected a fake appService).

```bash
git add src/hooks/useReplicaPull.ts <callers/tests>
git commit -m "refactor(effect): drop dead appService param threading in useReplicaPull (E5a)"
```

---

## Task FINAL: full verification + memory

- [ ] **Step 1: Behavioral grep gate.**

Run: `grep -rnE 'appService(\?\.|\.)' src --include=*.ts --include=*.tsx | grep -v '__tests__' | grep -vE 'src/services/(appService|nativeAppService|webAppService|nodeAppService|cloudService)\.ts:|src/domain/system\.ts:|src/services/environment\.ts:|src/infra/|src/libs/storage\.ts:'`
Expected: ONLY render-readiness guards (`Providers.tsx`, `library/index.tsx` `if (!appService)`), `EnvContext.tsx`, `EffectRuntimeProvider.tsx` (comment), and `useOPDSSubscriptions`/other `if (!appService)` guards. NO flag reads, NO IO calls.

- [ ] **Step 2: getAppService gate.**

Run: `grep -rn 'getAppService' src --include=*.ts --include=*.tsx | grep -v '__tests__'`
Expected: only `src/context/EnvContext.tsx` + `src/services/environment.ts`.

- [ ] **Step 3: Lint.** `pnpm lint` → only the 2 pre-existing baseline errors (`scripts/upload-cjk-fonts-r2.ts`, `SettingsDialog.tsx` unused `lazy`).

- [ ] **Step 4: Tests.** `pnpm test` → green except the known env-flaky set (opds-req/hardcover/edgeTTS/turso-node + theme-store/useBookShortcuts collection). Investigate any NEW failure (likely a missed test-rebridge for a swept component).

- [ ] **Step 5: Update memory** `project_effect_client_foundation.md` with E5a DONE (the flag-sweep scope reality + that only readiness gates/EnvContext/legacy-param-surfaces remain on appService) and point at E5b.

---

## Self-Review notes (for the executor)

- **Spec coverage:** A1–A5 = the ~67-file flag sweep (spec Component A). B1–B7 = the IO consumers (spec Component B). C1–C5 = non-React flag readers + trivial drops (spec Component C). FINAL = verification.
- **Ordering:** Do C3 (openWith) and B2 (useFileSelector) before B6 (library/index), since B6 calls them. Otherwise tasks are independent. A-tasks are mutually parallel-safe (disjoint files) but must SKIP the exclusion list.
- **Type/name consistency:** flag names are identical AppService↔PlatformInfo (no rename). `LibraryRepository.load`/`SettingsRepository.load` are Effect-valued PROPERTIES (`(r) => r.load`, no parens); `save`/`isAvailable`/`getFileSize`/`selectFiles`/etc. are methods (`(r) => r.method(args)`). `Dialog.selectFiles` returns `readonly string[]` (spread to mutable); `selectDirectory`/`saveFile` return `Option<string>`.
- **Watch items:** the readiness gates (`if (!appService)`) STAY (E5b owns them) — every B/library grep-gate allows exactly those. `getPlatformInfo()` flags are always-defined (no `?.`), so `appService?.X && y` becomes `platformInfo.X && y` (drop the `?.`). Don't add `platformInfo` to dep arrays (stable).
