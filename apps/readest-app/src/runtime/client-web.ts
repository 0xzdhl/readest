import { Layer, ManagedRuntime } from 'effect';
import { PathStateLive } from '@/application/ports/PathState';
import { WebPlatformLive } from '@/infra/web/WebPlatform.layer';
import { WebPathResolverLive } from '@/infra/web/WebPathResolver.layer';
import { WebFileSystemLive } from '@/infra/web/WebFileSystem.layer';
import { WebDialogLive } from '@/infra/web/WebDialog.layer';
import { WebDatabaseLive } from '@/infra/web/WebDatabase.layer';
import { SettingsRepositoryLive } from '@/infra/shared/SettingsRepository.layer';
import { MigrationServiceLive } from '@/infra/shared/MigrationService.layer';
import { CoverServiceLive } from '@/infra/shared/CoverService.layer';
import { BookRepositoryLive } from '@/infra/shared/BookRepository.layer';
import { LibraryRepositoryLive } from '@/infra/shared/LibraryRepository.layer';
import { FontServiceLive } from '@/infra/shared/FontService.layer';
import { ImageServiceLive } from '@/infra/shared/ImageService.layer';
import { DictionaryServiceLive } from '@/infra/shared/DictionaryService.layer';
import { CloudServiceLive } from '@/infra/shared/CloudService.layer';

// Analogous to client-tauri. The Web PathResolver/Dialog have no PathState dependency,
// but composing the same way is harmless and keeps PathState available to consumers that
// expect it (and consistent with the Tauri runtime).
const ResolverWithState = Layer.provideMerge(WebPathResolverLive, PathStateLive);

const Consumers = Layer.provide(
  Layer.mergeAll(WebFileSystemLive, WebDatabaseLive, WebDialogLive),
  ResolverWithState,
);

// Base over which the shared (platform-agnostic) repos/services are built: Platform plus the
// resolved PathResolver/PathState and the FileSystem/Database/Dialog consumers.
const SharedBase = Layer.mergeAll(WebPlatformLive, ResolverWithState, Consumers);

// SettingsRepository + MigrationService + CoverService + BookRepository depend only on the base
// (FileSystem/PathResolver/Platform). LibraryRepository additionally depends on CoverService, so
// build CoverService once (provideMerge keeps it in the output) and layer the rest — including
// LibraryRepository — over the base extended with that CoverService. BootApp (run observe-only by
// the bridge) requires them, so expose them from the runtime.
const SharedBaseWithCover = Layer.provideMerge(CoverServiceLive, SharedBase);

const SharedRepos = Layer.provideMerge(
  Layer.mergeAll(
    SettingsRepositoryLive,
    MigrationServiceLive,
    BookRepositoryLive,
    LibraryRepositoryLive,
    FontServiceLive,
    ImageServiceLive,
    DictionaryServiceLive,
    CloudServiceLive,
  ),
  SharedBaseWithCover,
);

export const WebClientLayer = Layer.mergeAll(
  WebPlatformLive,
  ResolverWithState,
  Consumers,
  SharedRepos,
);

export const webClientRuntime = ManagedRuntime.make(WebClientLayer);
