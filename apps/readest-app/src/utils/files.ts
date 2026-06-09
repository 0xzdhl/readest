import { Effect } from 'effect';
import type { FileItem } from '@/domain/system';
import { FileSystem } from '@/application/ports/FileSystem';
import { getClientRuntime } from '@/runtime/clientRuntime';

export const copyFiles = async (srcDir: string, dstDir: string) => {
  const runtime = getClientRuntime();

  let filesToCopy: FileItem[] = [];
  try {
    filesToCopy = await runtime.runPromise(
      Effect.flatMap(FileSystem, (fs) => fs.readDir(srcDir, 'None')),
    );
  } catch {
    throw new Error(`Dir ${srcDir} failed to read.`);
  }

  for (let i = 0; i < filesToCopy.length; i++) {
    const file = filesToCopy[i]!;
    const srcPath = `${srcDir}/${file.path}`;
    const destPath = `${dstDir}/${file.path}`;
    await runtime.runPromise(
      Effect.flatMap(FileSystem, (fs) => fs.copyFile(srcPath, 'None', destPath, 'None')),
    );
  }

  const filesCopied = await runtime.runPromise(
    Effect.flatMap(FileSystem, (fs) => fs.readDir(dstDir, 'None')),
  );
  for (const file of filesToCopy) {
    if (!filesCopied.find((f) => f.path === file.path && f.size === file.size)) {
      throw new Error(`File ${file.path} failed to copy.`);
    }
  }
};
