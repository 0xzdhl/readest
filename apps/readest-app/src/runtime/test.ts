import { Layer, ManagedRuntime } from 'effect';
import { PathStateLive } from '@/application/ports/PathState';
import { TestPlatformLive } from '@/__tests__/support/TestPlatform.layer';
import { TestPathResolverLive } from '@/__tests__/support/TestPathResolver.layer';
import { TestFileSystemLive } from '@/__tests__/support/TestFileSystem.layer';
import { SettingsRepositoryLive } from '@/infra/shared/SettingsRepository.layer';
import { MigrationServiceLive } from '@/infra/shared/MigrationService.layer';

// provideMerge: build PathStateLive once, expose both PathResolver AND PathState from it (shared ref).
const ResolverWithState = Layer.provideMerge(TestPathResolverLive, PathStateLive);

// The ports (Platform, FileSystem, PathResolver, PathState) are built once and shared.
const Ports = Layer.mergeAll(TestPlatformLive, TestFileSystemLive, ResolverWithState);

// SettingsRepository + MigrationService live layers, provided over the shared test ports.
// They consume Ports (without re-building them), so PathState stays shared with usecases.
const Repos = Layer.provide(Layer.mergeAll(SettingsRepositoryLive, MigrationServiceLive), Ports);

// Expose both the ports AND the repos/services from the same construction.
export const TestLayer = Layer.merge(Ports, Repos);

export const testRuntime = ManagedRuntime.make(TestLayer);
