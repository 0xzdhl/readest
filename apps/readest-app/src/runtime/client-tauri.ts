import { Layer, ManagedRuntime } from 'effect';
import { PathStateLive } from '@/application/ports/PathState';
import { TauriPlatformLive } from '@/infra/tauri/TauriPlatform.layer';
import { TauriPathResolverLive } from '@/infra/tauri/TauriPathResolver.layer';
import { TauriFileSystemLive } from '@/infra/tauri/TauriFileSystem.layer';
import { TauriDialogLive } from '@/infra/tauri/TauriDialog.layer';
import { TauriDatabaseLive } from '@/infra/tauri/TauriDatabase.layer';

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

export const TauriClientLayer = Layer.mergeAll(TauriPlatformLive, ResolverWithState, Consumers);

export const tauriClientRuntime = ManagedRuntime.make(TauriClientLayer);
