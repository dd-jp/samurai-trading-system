import { constants, copyFileSync, readFileSync } from 'node:fs';

export function snapshotPathFor(path: string): string {
  return path.replace(/(\.[^./]+)?$/, '.snapshot$1');
}

export function seedFromSnapshot(path: string, snapshot: string = snapshotPathFor(path)): boolean {
  try {
    copyFileSync(snapshot, path, constants.COPYFILE_EXCL);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    // Without a snapshot the caller's own read of the live file names what is missing
    if (code === 'EEXIST' || code === 'ENOENT') return false;
    throw error;
  }
}

// A gitignored live file the runtime appends to is recreated from its tracked sibling
// `<name>.snapshot.<ext>` when a pull or a fresh checkout leaves it absent (#2000)
export function readSeededFile(path: string): string {
  seedFromSnapshot(path);
  return readFileSync(path, 'utf8');
}
