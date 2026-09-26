import { readFile } from 'node:fs/promises';
import type { ServerResponse } from 'node:http';
import { extname, isAbsolute, join, relative, resolve, sep } from 'node:path';

export const DEFAULT_BUNDLE_ROOT = 'dist/client';

const CONTENT_TYPES: ReadonlyMap<string, string> = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.svg', 'image/svg+xml'],
  ['.png', 'image/png'],
  ['.ico', 'image/x-icon'],
  ['.woff', 'font/woff'],
  ['.woff2', 'font/woff2'],
]);

const BUNDLE_HEADERS = {
  'Cache-Control': 'no-cache',
  'X-Content-Type-Options': 'nosniff',
} as const;

export type BundleFile =
  | { readonly kind: 'file'; readonly path: string; readonly contentType: string }
  | { readonly kind: 'bad-request' }
  | { readonly kind: 'not-found' };

export function resolveBundleFile(root: string, rawPath: string): BundleFile {
  let urlPath: string;
  try {
    urlPath = decodeURIComponent(rawPath);
  } catch {
    return { kind: 'bad-request' };
  }
  if (urlPath.includes('\0')) return { kind: 'bad-request' };
  const bundleRoot = resolve(root);
  const path = resolve(bundleRoot, `.${urlPath === '/' ? '/index.html' : urlPath}`);
  const rel = relative(bundleRoot, path);
  if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    return { kind: 'not-found' };
  }
  const contentType = CONTENT_TYPES.get(extname(path).toLowerCase());
  return contentType === undefined ? { kind: 'not-found' } : { kind: 'file', path, contentType };
}

function sendText(res: ServerResponse, status: number, body: string): void {
  res
    .writeHead(status, { ...BUNDLE_HEADERS, 'Content-Type': 'text/plain; charset=utf-8' })
    .end(body);
}

async function readOrNull(path: string): Promise<Buffer | null> {
  try {
    return await readFile(path);
  } catch {
    return null;
  }
}

export async function serveBundle(
  root: string,
  rawPath: string,
  res: ServerResponse,
): Promise<void> {
  const file = resolveBundleFile(root, rawPath);
  if (file.kind === 'bad-request') {
    sendText(res, 400, 'bad request');
    return;
  }
  const body = file.kind === 'file' ? await readOrNull(file.path) : null;
  if (file.kind === 'file' && body !== null) {
    res.writeHead(200, { ...BUNDLE_HEADERS, 'Content-Type': file.contentType }).end(body);
  } else if ((await readOrNull(join(resolve(root), 'index.html'))) === null) {
    sendText(res, 503, `dashboard bundle not built: run \`npm run build:web\` (${resolve(root)})`);
  } else {
    sendText(res, 404, 'not found');
  }
}
