import { Layer, ManagedRuntime } from 'effect';
import { PathStateLive } from '@/application/ports/PathState';
import { TauriPlatformLive } from '@/infra/tauri/TauriPlatform.layer';
import { TauriPathResolverLive } from '@/infra/tauri/TauriPathResolver.layer';
import { TauriFileSystemLive } from '@/infra/tauri/TauriFileSystem.layer';
import { TauriDialogLive } from '@/infra/tauri/TauriDialog.layer';
import { TauriDatabaseLive } from '@/infra/tauri/TauriDatabase.layer';
import { SettingsRepositoryLive } from '@/infra/shared/SettingsRepository.layer';
import { MigrationServiceLive } from '@/infra/shared/MigrationService.layer';
import { CoverServiceLive } from '@/infra/shared/CoverService.layer';
import { BookRepositoryLive } from '@/infra/shared/BookRepository.layer';
import { LibraryRepositoryLive } from '@/infra/shared/LibraryRepository.layer';
import { FontServiceLive } from '@/infra/shared/FontService.layer';
import { ImageServiceLive } from '@/infra/shared/ImageService.layer';
import { DictionaryServiceLive } from '@/infra/shared/DictionaryService.layer';
import { CloudServiceLive } from '@/infra/shared/CloudService.layer';

// PathState is shared by PathResolver, FileSystem, Database — build it once and feed
// it to all three. PathResolver depends on PathState; FileSystem/Database/Dialog depend
// on PathResolver. Provide PathState to the PathResolver, then provide that resolved
// PathResolver (which still re-exports PathState via provideMerge) to the consumers so
// the whole graph closes to requirement `never`.
const ResolverWithState = Layer.provideMerge(TauriPathResolverLive, PathStateLive);

const Consumers = Layer.provide(
  Layer.mergeAll(TauriFileSystemLive, TauriDatabaseLive, TauriDialogLive),
  ResolverWithState,
);

// Base over which the shared (platform-agnostic) repos/services are built: Platform plus the
// resolved PathResolver/PathState and the FileSystem/Database/Dialog consumers.
const SharedBase = Layer.mergeAll(TauriPlatformLive, ResolverWithState, Consumers);

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

export const TauriClientLayer = Layer.mergeAll(
  TauriPlatformLive,
  ResolverWithState,
  Consumers,
  SharedRepos,
);

export const tauriClientRuntime = ManagedRuntime.make(TauriClientLayer);
