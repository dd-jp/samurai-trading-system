import { isAbsolute, resolve } from 'node:path';

export function isMainModule(moduleUrl: string): boolean {
  const invokedPath = process.argv[1];
  return (
    invokedPath !== undefined &&
    moduleUrl ===
      new URL(`file://${isAbsolute(invokedPath) ? invokedPath : resolve(invokedPath)}`).href
  );
}
