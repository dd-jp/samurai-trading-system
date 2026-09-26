import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveBundleFile, serveBundle } from './bundle.js';

const ROOT = '/srv/bundle';
const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function recorder() {
  const sent: { status?: number; headers?: Record<string, string>; body?: string } = {};
  const res = {
    writeHead(status: number, headers: Record<string, string>) {
      sent.status = status;
      sent.headers = headers;
      return this;
    },
    end(body: string) {
      sent.body = String(body);
    },
  };
  return { res: res as unknown as ServerResponse, sent };
}

describe('resolveBundleFile', () => {
  it('maps / to index.html and a known extension to its content type', () => {
    expect(resolveBundleFile(ROOT, '/')).toEqual({
      kind: 'file',
      path: resolve(ROOT, 'index.html'),
      contentType: 'text/html; charset=utf-8',
    });
    expect(resolveBundleFile(ROOT, '/assets/Font.WOFF2')).toMatchObject({
      kind: 'file',
      contentType: 'font/woff2',
    });
  });

  it.each([
    ['/app.js', 'text/javascript; charset=utf-8'],
    ['/app.css', 'text/css; charset=utf-8'],
    ['/logo.svg', 'image/svg+xml'],
    ['/logo.png', 'image/png'],
    ['/favicon.ico', 'image/x-icon'],
    ['/font.woff', 'font/woff'],
  ])('serves %s as %s', (path, contentType) => {
    expect(resolveBundleFile(ROOT, path)).toMatchObject({ kind: 'file', contentType });
  });

  it.each(['/.', '/..'])(
    'never serves the root or its parent, even named like a file: %s',
    (path) => {
      expect(resolveBundleFile('/srv/site.js/bundle.css', path)).toEqual({ kind: 'not-found' });
    },
  );

  it.each(['/assets', '/data.json', '/../etc/passwd.html', '/a/%2e%2e/%2e%2e/x.js'])(
    'finds nothing for %s',
    (path) => {
      expect(resolveBundleFile(ROOT, path)).toEqual({ kind: 'not-found' });
    },
  );

  it.each(['/%E0%A4%A', '/x%00.js'])('refuses a malformed path %s', (path) => {
    expect(resolveBundleFile(ROOT, path)).toEqual({ kind: 'bad-request' });
  });
});

function builtBundle(): string {
  const dir = mkdtempSync(join(tmpdir(), 'v2-bundle-'));
  dirs.push(dir);
  mkdirSync(join(dir, 'assets'));
  writeFileSync(join(dir, 'index.html'), '<html>');
  writeFileSync(join(dir, 'assets', 'app.js'), 'run()');
  return dir;
}

const TEXT_HEADERS = {
  'Cache-Control': 'no-cache',
  'X-Content-Type-Options': 'nosniff',
  'Content-Type': 'text/plain; charset=utf-8',
};

describe('serveBundle', () => {
  it('serves a bundle file with its type and no caching', async () => {
    const { res, sent } = recorder();
    await serveBundle(builtBundle(), '/assets/app.js', res);
    expect(sent).toEqual({
      status: 200,
      headers: { ...TEXT_HEADERS, 'Content-Type': 'text/javascript; charset=utf-8' },
      body: 'run()',
    });
  });

  it('answers a missing file 404 and a malformed path 400, as plain text', async () => {
    const dir = builtBundle();
    const missing = recorder();
    await serveBundle(dir, '/assets/gone.js', missing.res);
    expect(missing.sent).toEqual({ status: 404, headers: TEXT_HEADERS, body: 'not found' });
    const malformed = recorder();
    await serveBundle(dir, '/%E0%A4%A', malformed.res);
    expect(malformed.sent).toEqual({ status: 400, headers: TEXT_HEADERS, body: 'bad request' });
  });

  it('says the bundle is not built when the root has no index.html', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'v2-empty-bundle-'));
    dirs.push(dir);
    const { res, sent } = recorder();
    await serveBundle(dir, '/', res);
    expect(sent.status).toBe(503);
    expect(sent.headers).toEqual(TEXT_HEADERS);
    expect(sent.body).toContain('npm run build:web');
  });
});
