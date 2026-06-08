import { Layer, ManagedRuntime } from 'effect';
import { PathStateLive } from '@/application/ports/PathState';
import { TestPlatformLive } from '@/__tests__/support/TestPlatform.layer';
import { TestPathResolverLive } from '@/__tests__/support/TestPathResolver.layer';
import { TestFileSystemLive } from '@/__tests__/support/TestFileSystem.layer';

// provideMerge: build PathStateLive once, expose both PathResolver AND PathState from it (shared ref).
const ResolverWithState = Layer.provideMerge(TestPathResolverLive, PathStateLive);

export const TestLayer = Layer.mergeAll(TestPlatformLive, TestFileSystemLive, ResolverWithState);

export const testRuntime = ManagedRuntime.make(TestLayer);
