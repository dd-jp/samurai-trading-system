import { mkdtempSync, rmSync } from 'node:fs';
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

describe('serveBundle', () => {
  it('says the bundle is not built when the root has no index.html', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'v2-empty-bundle-'));
    dirs.push(dir);
    const { res, sent } = recorder();
    await serveBundle(dir, '/', res);
    expect(sent.status).toBe(503);
    expect(sent.headers).toMatchObject({ 'Cache-Control': 'no-cache' });
    expect(sent.body).toContain('npm run build:web');
  });
});
