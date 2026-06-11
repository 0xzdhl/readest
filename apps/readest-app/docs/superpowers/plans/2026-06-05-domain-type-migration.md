# Domain Type-Layer Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move all TypeScript _type_ definitions reachable from `types/{book,settings,system}.ts` into a new, pure `src/domain/` layer, rewrite every importer to `@/domain/*`, and delete the old type files / temporary barrels — with the build green after every task.

**Architecture:** Leaf-first incremental migration. Each source module's types move to a 1:1 `@/domain/<name>` file. During migration the original path keeps resolving via a temporary re-export barrel, so `pnpm lint` (tsgo typecheck) and `pnpm test` stay green at every commit. A final cleanup phase rewrites all importers to `@/domain/*` and removes the barrels, leaving no shims. `domain/` must never import from `@/services`, `@/store`, `@/styles`, `@/hooks`, `@/components`, `@/app`, or `@/utils` runtime modules — enforced by a purity test.

**Tech Stack:** TypeScript (strict, ES2022), Biome + tsgo (`pnpm lint`), Vitest (`pnpm test`). Path alias `@/* → src/*`.

**Prerequisite design:** `docs/superpowers/specs/2026-06-05-effect-foundation-phase1-2-design.md` (this is the type-migration prerequisite ahead of the Effect foundation plans B/C/D).

---

## Source → Domain mapping (the migration table)

This is the single source of truth for every move. `kind` = `move` (type-only file, becomes a barrel) or `split` (mixed runtime+type module: extract listed symbols, leave runtime, original re-exports the symbols from domain during migration).

| #   | Source module                                    | Domain file                            | kind  | Symbols to place in domain                                                                                                                                                                                                                                                    |
| --- | ------------------------------------------------ | -------------------------------------- | ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| L1  | `src/types/annotator.ts`                         | `src/domain/annotator.ts`              | move  | `AnnotationToolType`                                                                                                                                                                                                                                                          |
| L2  | `src/types/misc.ts`                              | `src/domain/misc.ts`                   | move  | `Insets`, `LocaleWithTextInfo`                                                                                                                                                                                                                                                |
| L3  | `src/services/tts/types.ts`                      | `src/domain/tts.ts`                    | move  | `TTSGranularity`, `TTSMediaMetadataMode`, `TTSHighlightOptions`, `TTSVoice`, `TTSVoicesGroup`, `TTSMark`                                                                                                                                                                      |
| L4  | `src/services/ai/types.ts`                       | `src/domain/ai.ts`                     | move  | `AIProviderName`, `AIProvider`, `AISettings`, `TextChunk`, `ScoredChunk`, `BookIndexMeta`, `IndexingState`, `EmbeddingProgress`, `AIConversation`, `AIMessage`                                                                                                                |
| L5  | `src/services/dictionaries/types.ts`             | `src/domain/dictionaries.ts`           | move  | all exports (`DictionaryProviderKind`, `DictionaryLookupContext`, `DictionaryLookupOutcome`, `DictionaryProvider`, `ImportedDictionary`, `WebSearchEntry`, `DictionarySettings`, `BUILTIN_PROVIDER_IDS`, `BuiltinProviderId`, `BUILTIN_WEB_SEARCH_IDS`, `BuiltinWebSearchId`) |
| L6  | `src/types/opds.ts`                              | `src/domain/opds.ts`                   | move  | all exports (incl. `REL`, `SYMBOL`, `OPDSCatalog`)                                                                                                                                                                                                                            |
| L7  | `src/types/database.ts`                          | `src/domain/database.ts`               | move  | `DatabaseOpts` (re-export), `DatabaseExecResult`, `DatabaseRow`, `DatabaseService`                                                                                                                                                                                            |
| S1  | `src/utils/sel.ts`                               | `src/domain/selection.ts`              | split | `Frame`, `Rect`, `Point`, `PositionDir`, `Position`, `TextSelection` (and any other pure types in the file)                                                                                                                                                                   |
| S2  | `src/utils/transfer.ts`                          | `src/domain/transfer.ts`               | split | `UploadMethod`, `ProgressPayload`, `ProgressHandler`, `UploadFileError`                                                                                                                                                                                                       |
| S3  | `src/utils/book.ts`                              | `src/domain/metadata.ts`               | split | `LanguageMap`, `Identifier`, `Collection`, `Contributor` (pure metadata types used by `BookMetadata`)                                                                                                                                                                         |
| S4  | `src/services/database/migrate.ts`               | `src/domain/migration.ts`              | split | `MigrationEntry`, `SchemaType`, `MigrateOptions`                                                                                                                                                                                                                              |
| S5  | `src/libs/document` (index)                      | `src/domain/document.ts`               | split | `DocumentFile`, `Location`, `TOCItem`, `SectionFragment`, `SectionItem`, `BookMetadata`, `BookDoc`, `EXTS`, `MIMETYPES`                                                                                                                                                       |
| S6  | `src/styles/themes.ts`                           | `src/domain/themes.ts`                 | split | `BaseColor`, `ThemeMode`, `Palette`, `Theme`, `CustomTheme`                                                                                                                                                                                                                   |
| S7  | `src/styles/fonts.ts`                            | `src/domain/fonts.ts`                  | split | `FontFormat`, `CustomFont`, `CustomFontInfo`                                                                                                                                                                                                                                  |
| L8  | `src/styles/textures.ts`                         | `src/domain/textures.ts`               | move  | `BackgroundTexture`, `CustomTexture`, `CustomTextureInfo`                                                                                                                                                                                                                     |
| S8  | `src/store/notebookStore.ts`                     | `src/domain/notebook.ts`               | split | `NotebookTab`                                                                                                                                                                                                                                                                 |
| S9  | `src/hooks/useFileSelector.ts`                   | `src/domain/file-selector.ts`          | split | `FileSelectorOptions`, `SelectedFile`, `FileSelectionResult`                                                                                                                                                                                                                  |
| S10 | `src/services/nav/index.ts`                      | `src/domain/nav.ts`                    | split | `BookNavSection`, `BookNav`, `BOOK_NAV_VERSION`                                                                                                                                                                                                                               |
| R1  | `src/types/book.ts`                              | `src/domain/book.ts`                   | move  | all exports                                                                                                                                                                                                                                                                   |
| R2  | `src/types/settings.ts`                          | `src/domain/settings.ts`               | move  | all exports                                                                                                                                                                                                                                                                   |
| R3  | `src/types/view.ts`                              | `src/domain/view.ts`                   | split | `Renderer`, `FoliateView` (leave `wrappedFoliateView` runtime)                                                                                                                                                                                                                |
| R4  | `src/types/system.ts`                            | `src/domain/system.ts`                 | move  | all exports (incl. `AppService`, `FileSystem` interfaces)                                                                                                                                                                                                                     |
| S11 | `src/services/dictionaries/dictionaryService.ts` | append to `src/domain/dictionaries.ts` | split | `ImportDictionariesResult`                                                                                                                                                                                                                                                    |

**Dependency order (leaf-first):** L1–L8 (no internal deps) → S1, S2, S3, S4 → S5 (needs S3) → S6, S7, S8, S9 → S10 (needs R1, S5) → R1 (needs L1, L3, S5) → R2 (needs R1, L5, L6, L4, S6, S7, L8, S8) → R3 (needs R1, S5, L3) → R4 (needs R1, R2, S5, S10, S2, S7, L8, L7, S4, L5, S9) → S11 → Cleanup.

> If `R1`/`R2`/`R4` import a symbol that hasn't moved yet, import it from its _temporary barrel_ (old path) — that still resolves. Order above guarantees each domain file's deps already exist in `domain/` by the time it's created, except where a barrel covers it.

---

## Per-module recipe (READ BEFORE EVERY TASK)

Every module task below is an instance of ONE of two recipes. Each task states its row (paths + symbols); apply the matching recipe.

### Recipe MOVE (type-only file → barrel)

1. **Create** the domain file by moving the _entire contents_ of the source file into it. For each internal import in the moved content that points at a module already migrated, repoint it to `@/domain/<name>` (per the table); leave external/not-yet-migrated imports untouched (they resolve via barrels).
2. **Replace** the source file's body with a single barrel line: `export * from '@/domain/<name>';`
3. **Verify** typecheck stays green: `pnpm lint` (or faster: `pnpm exec tsgo --noEmit`).
4. **Commit.**

### Recipe SPLIT (mixed module → extract types, leave runtime)

1. **Create** the domain file containing _only_ the listed type symbols (copy their definitions verbatim; repoint any already-migrated internal imports to `@/domain/*`).
2. **Edit** the source module: delete the moved type _definitions_, add `import type { … } from '@/domain/<name>';` for any of those symbols still referenced by the remaining runtime code, and add a re-export line so external importers keep working during migration:
   `export type { Sym1, Sym2 } from '@/domain/<name>';` (use `export {` instead of `export type {` for value symbols like `EXTS`, `BOOK_NAV_VERSION`, `UploadMethod` enum).
3. **Verify** typecheck stays green.
4. **Commit.**

> Temp barrels/re-exports are removed in the Cleanup phase. They exist only to keep the tree green between tasks.

---

## Task 0: Scaffold `domain/` and the purity guard

**Files:**

- Create: `src/domain/.gitkeep` (placeholder; removed once first real file lands)
- Create: `src/__tests__/domain/purity.test.ts`

- [ ] **Step 1: Write the failing purity test**

```ts
// src/__tests__/domain/purity.test.ts
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const DOMAIN_DIR = join(process.cwd(), 'src/domain');
const FORBIDDEN = [
  /from\s+['"]@\/services\b/,
  /from\s+['"]@\/store\b/,
  /from\s+['"]@\/styles\b/,
  /from\s+['"]@\/hooks\b/,
  /from\s+['"]@\/components\b/,
  /from\s+['"]@\/app\b/,
  /from\s+['"]@\/context\b/,
  /from\s+['"]@\/utils\b/,
  /from\s+['"]@\/libs\b/,
];

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (p.endsWith('.ts') || p.endsWith('.tsx')) out.push(p);
  }
  return out;
}

describe('domain layer purity', () => {
  it('does not import from runtime modules', () => {
    const offenders: string[] = [];
    for (const file of walk(DOMAIN_DIR)) {
      const src = readFileSync(file, 'utf8');
      for (const re of FORBIDDEN) {
        if (re.test(src)) offenders.push(`${file} :: ${re}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
```

- [ ] **Step 2: Run it — expect FAIL or empty-dir error**

Run: `pnpm exec vitest run src/__tests__/domain/purity.test.ts`
Expected: FAIL (`readdirSync` throws ENOENT because `src/domain` does not exist yet).

- [ ] **Step 3: Create the directory**

```bash
mkdir -p src/domain && touch src/domain/.gitkeep
```

- [ ] **Step 4: Run it — expect PASS**

Run: `pnpm exec vitest run src/__tests__/domain/purity.test.ts`
Expected: PASS (no `.ts` files in `domain/` yet → no offenders).

- [ ] **Step 5: Commit**

```bash
git add src/domain/.gitkeep src/__tests__/domain/purity.test.ts
git commit -m "chore(domain): scaffold domain layer + purity guard test"
```

---

## Phase 1 — Leaf type-only modules (Recipe MOVE)

> Each task: apply **Recipe MOVE** for the named row, then run `pnpm lint` + `pnpm exec vitest run src/__tests__/domain/purity.test.ts`, then commit. Commit message: `refactor(domain): move <name> types to domain/<name>`.

- [ ] **Task L1 — `types/annotator.ts` → `domain/annotator.ts`**
  - MOVE. `domain/annotator.ts` gets `export type AnnotationToolType = …` (copy from source).
  - `types/annotator.ts` body becomes: `export * from '@/domain/annotator';`
  - Verify: `pnpm lint` green; purity test green. Commit.

- [ ] **Task L2 — `types/misc.ts` → `domain/misc.ts`** (MOVE; symbols `Insets`, `LocaleWithTextInfo`). Barrel old file. Verify + commit.

- [ ] **Task L3 — `services/tts/types.ts` → `domain/tts.ts`** (MOVE; 6 TTS symbols). Barrel old file: `export * from '@/domain/tts';`. Verify + commit.

- [ ] **Task L4 — `services/ai/types.ts` → `domain/ai.ts`** (MOVE; 10 AI symbols; keep the external `import type { LanguageModel, EmbeddingModel } from 'ai'`). Barrel old file. Verify + commit.

- [ ] **Task L5 — `services/dictionaries/types.ts` → `domain/dictionaries.ts`** (MOVE; all exports). Barrel old file. Verify + commit.

- [ ] **Task L6 — `types/opds.ts` → `domain/opds.ts`** (MOVE; all exports; keep external foliate-js imports). Barrel old file. Verify + commit.

- [ ] **Task L7 — `types/database.ts` → `domain/database.ts`** (MOVE; keep `export type { DatabaseOpts } from '@readest/turso-database-common'` and the other types). Barrel old file. Verify + commit.

- [ ] **Task L8 — `styles/textures.ts` → `domain/textures.ts`**
  - SPECIAL: `styles/textures.ts` currently imports `md5Fingerprint`/`getFilename` at the top but only the _types_ are exported here. Confirm whether the file has any runtime exports.
  - If the file is type-only in practice (only `BackgroundTexture`/`CustomTexture`/`CustomTextureInfo` exported, imports unused for types) → apply Recipe MOVE.
  - If it has runtime exports → apply Recipe SPLIT (extract the 3 types, leave runtime, re-export).
  - Verify + commit.

---

## Phase 2 — Mixed util/lib modules (Recipe SPLIT)

- [ ] **Task S1 — `utils/sel.ts` → `domain/selection.ts`**
  - SPLIT. Copy the pure geometry/selection types (`Frame`, `Rect`, `Point`, `PositionDir`, `Position`, `TextSelection`, plus any other pure types declared there) into `domain/selection.ts`.
  - In `utils/sel.ts`: remove those type _definitions_, add `import type { … } from '@/domain/selection';` if the runtime code references them, and `export type { Frame, Rect, Point, PositionDir, Position, TextSelection } from '@/domain/selection';`.
  - Verify (`pnpm lint` + purity) + commit: `refactor(domain): extract selection types to domain/selection`.

- [ ] **Task S2 — `utils/transfer.ts` → `domain/transfer.ts`**
  - SPLIT. Put `UploadMethod` (enum), `ProgressPayload`, `ProgressHandler`, `UploadFileError` (enum) in `domain/transfer.ts`.
  - `utils/transfer.ts`: delete those defs; `import { UploadMethod, UploadFileError } from '@/domain/transfer';` and `import type { ProgressPayload, ProgressHandler } from '@/domain/transfer';` as needed by the runtime; re-export: `export { UploadMethod, UploadFileError } from '@/domain/transfer';` and `export type { ProgressPayload, ProgressHandler } from '@/domain/transfer';`.
  - Verify + commit.

- [ ] **Task S3 — `utils/book.ts` → `domain/metadata.ts`**
  - SPLIT. Extract `LanguageMap`, `Identifier`, `Collection`, `Contributor` (and any pure metadata types `BookMetadata` depends on). Leave all runtime functions in `utils/book.ts`.
  - `utils/book.ts`: remove the type defs, re-export them from `@/domain/metadata`, and `import type` them where used.
  - Verify + commit.

- [ ] **Task S4 — `services/database/migrate.ts` → `domain/migration.ts`**
  - SPLIT. Extract `MigrationEntry`, `SchemaType`, `MigrateOptions` into `domain/migration.ts`. These reference `DatabaseService` — import it from `@/domain/database` (already migrated in L7).
  - Leave the `migrate()` runtime function in `services/database/migrate.ts`; `import type { MigrationEntry, SchemaType, MigrateOptions } from '@/domain/migration';` and `export type { … } from '@/domain/migration';`.
  - Verify + commit.

- [ ] **Task S5 — `libs/document` → `domain/document.ts`**
  - SPLIT. Extract `DocumentFile`, `Location`, `TOCItem`, `SectionFragment`, `SectionItem`, `BookMetadata`, `BookDoc`, and the const maps `EXTS`, `MIMETYPES` into `domain/document.ts`. `BookMetadata` references metadata types — import them from `@/domain/metadata` (S3). Keep external foliate-js type imports.
  - Leave `DocumentLoader` class + all runtime utilities in `libs/document`. There, `import type { … } from '@/domain/document';`, `import { EXTS, MIMETYPES } from '@/domain/document';`, and re-export: `export type { DocumentFile, Location, TOCItem, SectionFragment, SectionItem, BookMetadata, BookDoc } from '@/domain/document';` + `export { EXTS, MIMETYPES } from '@/domain/document';`.
  - Verify + commit.

---

## Phase 3 — Mixed style/store/hook modules (Recipe SPLIT)

- [ ] **Task S6 — `styles/themes.ts` → `domain/themes.ts`** (SPLIT; `BaseColor`, `ThemeMode`, `Palette`, `Theme`, `CustomTheme`). Leave `hexToOklch()` etc. Re-export the types. Verify + commit.

- [ ] **Task S7 — `styles/fonts.ts` → `domain/fonts.ts`** (SPLIT; `FontFormat`, `CustomFont`, `CustomFontInfo`). Leave the font-link generator functions. Re-export the types. Verify + commit.

- [ ] **Task S8 — `store/notebookStore.ts` → `domain/notebook.ts`** (SPLIT; `NotebookTab` union only). Leave the zustand `useNotebookStore`. In the store: `import type { NotebookTab } from '@/domain/notebook';` and `export type { NotebookTab } from '@/domain/notebook';`. Verify + commit.

- [ ] **Task S9 — `hooks/useFileSelector.ts` → `domain/file-selector.ts`** (SPLIT; `FileSelectorOptions`, `SelectedFile`, `FileSelectionResult`). Leave the hook + `selectFileWeb`/`selectFileTauri`. Re-export the types. Verify + commit.

---

## Phase 4 — Root types + nav/view (dependency-ordered)

- [ ] **Task R1 — `types/book.ts` → `domain/book.ts`**
  - MOVE (all exports incl. value consts `DEFAULT_HIGHLIGHT_COLORS`, `FIXED_LAYOUT_FORMATS`).
  - Repoint internal imports inside the moved content: `@/libs/document` → `@/domain/document` (BookMetadata), `@/services/tts/types` → `@/domain/tts`, `./annotator` → `@/domain/annotator`.
  - `types/book.ts` body becomes `export * from '@/domain/book';`.
  - Verify + commit.

- [ ] **Task S10 — `services/nav/index.ts` → `domain/nav.ts`**
  - SPLIT; `BookNavSection`, `BookNav`, `BOOK_NAV_VERSION` (value const). Repoint: `@/types/book` → `@/domain/book` (`ConvertChineseVariant`), `@/libs/document` → `@/domain/document` (`BookDoc`, `SectionFragment`, `TOCItem`).
  - Leave nav runtime; `import type { … } from '@/domain/nav'` + `import { BOOK_NAV_VERSION } from '@/domain/nav'`; re-export: `export type { BookNavSection, BookNav } from '@/domain/nav';` + `export { BOOK_NAV_VERSION } from '@/domain/nav';`.
  - Verify + commit.

- [ ] **Task R2 — `types/settings.ts` → `domain/settings.ts`**
  - MOVE (all exports). Repoint internal imports: `./book` → `@/domain/book`, `./opds` → `@/domain/opds`, `@/services/ai/types` → `@/domain/ai`, `@/services/dictionaries/types` → `@/domain/dictionaries`, `@/styles/themes` → `@/domain/themes`, `@/styles/fonts` → `@/domain/fonts`, `@/styles/textures` → `@/domain/textures`, `@/store/notebookStore` → `@/domain/notebook`.
  - `types/settings.ts` body becomes `export * from '@/domain/settings';`.
  - Verify + commit.

- [ ] **Task R3 — `types/view.ts` → `domain/view.ts`**
  - SPLIT; extract `Renderer`, `FoliateView` interfaces. Repoint internal type imports to `@/domain/*`. Leave `wrappedFoliateView` runtime in `types/view.ts`; `import type { Renderer, FoliateView } from '@/domain/view';` + `export type { Renderer, FoliateView } from '@/domain/view';`.
  - Verify + commit.

- [ ] **Task R4 — `types/system.ts` → `domain/system.ts`**
  - MOVE (all exports incl. `AppService`, `FileSystem` interfaces — they are pure interfaces). Repoint EVERY internal import to its `@/domain/*` home per the table: `./settings`→`@/domain/settings`, `./book`→`@/domain/book`, `@/libs/document`→`@/domain/document`, `@/services/nav`→`@/domain/nav`, `@/utils/transfer`→`@/domain/transfer`, `@/styles/fonts`→`@/domain/fonts`, `@/styles/textures`→`@/domain/textures`, `./database`→`@/domain/database`, `@/services/database/migrate`→`@/domain/migration`, `@/services/dictionaries/types`→`@/domain/dictionaries`, `@/services/dictionaries/dictionaryService`→`@/domain/dictionaries` (after S11), `@/hooks/useFileSelector`→`@/domain/file-selector`.
  - `types/system.ts` body becomes `export * from '@/domain/system';`.
  - Note: `domain/system.ts` will reference `ImportDictionariesResult` — do **S11 before R4** so the symbol exists in `@/domain/dictionaries`.
  - Verify + commit.

- [ ] **Task S11 — `services/dictionaries/dictionaryService.ts`: extract `ImportDictionariesResult`**
  - SPLIT (do this **before R4**). Move `ImportDictionariesResult` definition into `domain/dictionaries.ts` (append). In `dictionaryService.ts`: `import type { ImportDictionariesResult } from '@/domain/dictionaries';` + `export type { ImportDictionariesResult } from '@/domain/dictionaries';`.
  - Verify + commit.

> Execution note: reorder Phase 4 to **R1 → S10 → R2 → R3 → S11 → R4** so every dependency exists before use.

---

## Phase 5 — Add the `@/domain` barrel + checkpoint

- [ ] **Task 5.1 — Create `src/domain/index.ts` barrel**

```ts
// src/domain/index.ts — convenience barrel; import from specific modules in new code where practical
export * from './annotator';
export * from './misc';
export * from './tts';
export * from './ai';
export * from './dictionaries';
export * from './opds';
export * from './database';
export * from './selection';
export * from './transfer';
export * from './metadata';
export * from './migration';
export * from './document';
export * from './themes';
export * from './fonts';
export * from './textures';
export * from './notebook';
export * from './file-selector';
export * from './nav';
export * from './book';
export * from './settings';
export * from './view';
export * from './system';
```

> If two modules export a colliding name, `export *` will error at typecheck — resolve by removing the duplicate from the barrel and documenting it. Run `pnpm lint` to detect.

- [ ] **Step 2: Checkpoint A — full suite green (pure refactor, barrels still in place)**

Run: `pnpm test` then `pnpm lint`
Expected: both PASS. No behavior change; old `@/types/*`, `@/services/*`, `@/styles/*` paths still resolve via barrels.

- [ ] **Step 3: Commit**

```bash
git add src/domain/index.ts
git commit -m "refactor(domain): add domain barrel; checkpoint A (all green via temp barrels)"
```

---

## Phase 6 — Cleanup: rewrite importers to `@/domain/*`, remove temp barrels

The goal: every consumer imports types directly from `@/domain/*`; no temp barrel/re-export remains.

- [ ] **Task 6.1 — Rewrite importers of the fully-moved (MOVE) modules**

These have a 1:1 path swap (the whole old file was a barrel). Apply across `src/` (excluding the barrel files themselves and `src/domain/`):

```bash
# Run from apps/readest-app. Rewrites only the import specifier string.
# MOVE modules: old → new
declare -A MAP=(
  ["@/types/annotator"]="@/domain/annotator"
  ["@/types/misc"]="@/domain/misc"
  ["@/types/opds"]="@/domain/opds"
  ["@/types/database"]="@/domain/database"
  ["@/types/book"]="@/domain/book"
  ["@/types/settings"]="@/domain/settings"
  ["@/types/system"]="@/domain/system"
  ["@/services/tts/types"]="@/domain/tts"
  ["@/services/ai/types"]="@/domain/ai"
  ["@/services/dictionaries/types"]="@/domain/dictionaries"
  ["@/styles/textures"]="@/domain/textures"
)
for old in "${!MAP[@]}"; do
  new="${MAP[$old]}"
  grep -rl --include='*.ts' --include='*.tsx' "from '$old'" src \
    | grep -vE '^src/domain/' \
    | while read -r f; do
        # escape slashes for sed
        sed -i "s#from '$old'#from '$new'#g" "$f"
      done
done
```

> Important: `@/services/tts/types`, `@/services/ai/types`, `@/services/dictionaries/types` are MOVE modules (their original was a full barrel after L3/L4/L5). But `@/services/tts`, `@/services/ai`, `@/services/dictionaries` (without `/types`) are runtime modules — the `from '@/services/tts/types'` match is exact, so runtime imports are untouched. Verify with a diff review.

- [ ] **Step 2: Delete the MOVE barrels**

```bash
rm src/types/annotator.ts src/types/misc.ts src/types/opds.ts src/types/database.ts \
   src/types/book.ts src/types/settings.ts src/types/system.ts \
   src/services/tts/types.ts src/services/ai/types.ts src/services/dictionaries/types.ts \
   src/styles/textures.ts
```

> If `styles/textures.ts` was SPLIT (had runtime), do NOT delete it — instead handle it in Task 6.2.

- [ ] **Step 3: Verify**

Run: `pnpm lint`
Expected: PASS — zero unresolved imports. If a file still imports a deleted barrel, the codemod missed it (e.g. a dynamic import or re-export); fix manually.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "refactor(domain): rewrite MOVE-module importers to @/domain/*, delete barrels"
```

- [ ] **Task 6.2 — Rewrite importers of SPLIT modules (symbol-aware) and drop re-exports**

SPLIT modules still legitimately export runtime; only the _type_ symbols moved. For each SPLIT row, find importers that import a moved _type_ symbol from the old runtime path and repoint just that symbol to `@/domain/<name>`, then remove the temporary `export type { … }` re-export from the runtime module.

Per-module symbol set (old path → domain path :: symbols):

- `@/utils/sel` → `@/domain/selection` :: `Frame, Rect, Point, PositionDir, Position, TextSelection`
- `@/utils/transfer` → `@/domain/transfer` :: `UploadMethod, ProgressPayload, ProgressHandler, UploadFileError`
- `@/utils/book` → `@/domain/metadata` :: `LanguageMap, Identifier, Collection, Contributor`
- `@/services/database/migrate` → `@/domain/migration` :: `MigrationEntry, SchemaType, MigrateOptions`
- `@/libs/document` → `@/domain/document` :: `DocumentFile, Location, TOCItem, SectionFragment, SectionItem, BookMetadata, BookDoc, EXTS, MIMETYPES`
- `@/styles/themes` → `@/domain/themes` :: `BaseColor, ThemeMode, Palette, Theme, CustomTheme`
- `@/styles/fonts` → `@/domain/fonts` :: `FontFormat, CustomFont, CustomFontInfo`
- `@/store/notebookStore` → `@/domain/notebook` :: `NotebookTab`
- `@/hooks/useFileSelector` → `@/domain/file-selector` :: `FileSelectorOptions, SelectedFile, FileSelectionResult`
- `@/services/nav` → `@/domain/nav` :: `BookNavSection, BookNav, BOOK_NAV_VERSION`
- `@/services/dictionaries/dictionaryService` → `@/domain/dictionaries` :: `ImportDictionariesResult`
- `types/view.ts` → `@/domain/view` :: `Renderer, FoliateView` (importers use `@/types/view`)
  - [ ] **Step 1: Find every importer touching these symbols**

```bash
# Lists candidate files per old path for manual/codemod review:
for old in '@/utils/sel' '@/utils/transfer' '@/utils/book' '@/services/database/migrate' \
           '@/libs/document' '@/styles/themes' '@/styles/fonts' '@/store/notebookStore' \
           '@/hooks/useFileSelector' '@/services/nav' '@/services/dictionaries/dictionaryService' \
           '@/types/view'; do
  echo "=== $old ==="
  grep -rln --include='*.ts' --include='*.tsx' "from '$old'" src | grep -vE '^src/domain/'
done
```

- [ ] **Step 2: For each importer, split the import**

For a line like `import { useNotebookStore, type NotebookTab } from '@/store/notebookStore';`, split into:

```ts
import { useNotebookStore } from '@/store/notebookStore';
import type { NotebookTab } from '@/domain/notebook';
```

Apply per the symbol set above. Pure type-only imports (`import type { BookMetadata } from '@/libs/document'`) just repoint the path. Use ts-morph if available for accuracy; otherwise edit by hand guided by the Step-1 file lists. Keep runtime imports (`DocumentLoader`, `migrate`, `wrappedFoliateView`, store hooks, font generators) pointing at their original modules.

- [ ] **Step 3: Remove the temporary re-exports from the SPLIT runtime modules**

In each SPLIT module (`utils/sel.ts`, `utils/transfer.ts`, `utils/book.ts`, `services/database/migrate.ts`, `libs/document` index, `styles/themes.ts`, `styles/fonts.ts`, `store/notebookStore.ts`, `hooks/useFileSelector.ts`, `services/nav/index.ts`, `services/dictionaries/dictionaryService.ts`, `types/view.ts`), delete the `export type { … } from '@/domain/<name>';` / `export { … } from '@/domain/<name>';` lines added during SPLIT. Keep the `import type { … } from '@/domain/<name>';` lines the runtime still needs.

> If `types/view.ts` now contains _only_ `wrappedFoliateView` runtime and no exported types, that's fine — leave it as a runtime module. Do not delete it.

- [ ] **Step 4: Verify + Step 5: Commit**

Run: `pnpm lint` then `pnpm test`
Expected: both PASS, no re-export shims remain.

```bash
git add -A
git commit -m "refactor(domain): repoint SPLIT-module type imports to @/domain/*, drop re-exports"
```

---

## Phase 7 — Final verification (Checkpoint A complete)

- [ ] **Task 7.1 — Confirm no shims/barrels remain and domain is pure**
  - [ ] **Step 1: No old type-barrel paths remain**

```bash
# These MUST return nothing (files deleted, importers repointed):
grep -rn "from '@/types/book'"     src || echo "OK book"
grep -rn "from '@/types/settings'" src || echo "OK settings"
grep -rn "from '@/types/system'"   src || echo "OK system"
grep -rn "from '@/services/tts/types'" src || echo "OK tts"
grep -rn "from '@/services/ai/types'"  src || echo "OK ai"
```

Expected: each prints `OK …` (no matches).

- [ ] **Step 2: No leftover `export … from '@/domain/` re-export shims in runtime modules**

```bash
grep -rn "export \(type \)\?{[^}]*} from '@/domain/" src | grep -vE '^src/domain/index.ts'
```

Expected: empty (only `src/domain/index.ts` may re-export from `@/domain/*`).

- [ ] **Step 3: Purity + full suite**

Run: `pnpm exec vitest run src/__tests__/domain/purity.test.ts` → PASS
Run: `pnpm test` → PASS
Run: `pnpm lint` → PASS

- [ ] **Step 4: Remove the `.gitkeep` and commit final state**

```bash
rm -f src/domain/.gitkeep
git add -A
git commit -m "refactor(domain): complete type-layer migration; checkpoint A green"
```

---

## Done-conditions (whole plan)

- `pnpm test` green, `pnpm lint` (Biome + tsgo) green.
- `src/domain/` holds all moved types; `domain` purity test passes.
- No `@/types/{book,settings,system}` paths and no temporary re-export shims remain.
- Zero behavior change (pure refactor). Rust/Lua untouched → `fmt:check`/`clippy:check`/`test:lua` N/A.

## Risks & mitigations

- **Codemod over-reach** (rewriting a runtime import by accident) — mitigated by exact-string matching on the full specifier and a `git diff` review before each commit; SPLIT modules handled symbol-aware, never by blanket path swap.
- **Name collisions in the barrel** — surfaced immediately by `pnpm lint` at Task 5.1; resolve by trimming the barrel.
- **Hidden dynamic imports / string-built paths** — the Phase 7 grep gates catch any residual old paths.
- **A symbol assumed pure turns out to reference runtime** — caught by the purity test the moment its definition lands in `domain/`; if so, that symbol stays behind and is imported into domain via an interface boundary instead (note it and adjust).
