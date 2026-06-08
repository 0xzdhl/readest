import { Layer, ManagedRuntime } from 'effect';
import { PathStateLive } from '@/application/ports/PathState';
import { WebPlatformLive } from '@/infra/web/WebPlatform.layer';
import { WebPathResolverLive } from '@/infra/web/WebPathResolver.layer';
import { WebFileSystemLive } from '@/infra/web/WebFileSystem.layer';
import { WebDialogLive } from '@/infra/web/WebDialog.layer';
import { WebDatabaseLive } from '@/infra/web/WebDatabase.layer';

// Analogous to client-tauri. The Web PathResolver/Dialog have no PathState dependency,
// but composing the same way is harmless and keeps PathState available to consumers that
// expect it (and consistent with the Tauri runtime).
const ResolverWithState = Layer.provideMerge(WebPathResolverLive, PathStateLive);

const Consumers = Layer.provide(
  Layer.mergeAll(WebFileSystemLive, WebDatabaseLive, WebDialogLive),
  ResolverWithState,
);

export const WebClientLayer = Layer.mergeAll(WebPlatformLive, ResolverWithState, Consumers);

export const webClientRuntime = ManagedRuntime.make(WebClientLayer);
