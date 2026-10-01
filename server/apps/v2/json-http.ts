import type { IncomingMessage, Server } from 'node:http';

export const JSON_HEADERS = {
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
} as const;

export function parseJson(text: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false };
  }
}

export function isJsonRequest(req: IncomingMessage): boolean {
  return (req.headers['content-type'] ?? '').split(';')[0]?.trim() === 'application/json';
}

export function declaresLengthOver(req: IncomingMessage, maxBytes: number): boolean {
  return Number(req.headers['content-length'] ?? 0) > maxBytes;
}

export function parseListenPort(
  raw: string | undefined,
  defaultPort: number,
  variable: string,
): number {
  const port = Number(raw ?? defaultPort);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new Error(`${variable} must be an integer port (got ${raw})`);
  }
  return port;
}

export interface ServerLifecycle {
  start(): Promise<void>;
  stop(): Promise<void>;
}

export function serverLifecycle(
  server: Server,
  host: string,
  port: number,
  onBound: (boundPort: number) => void,
): ServerLifecycle {
  return {
    start: () =>
      new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => {
          const address = server.address();
          onBound(typeof address === 'object' && address !== null ? address.port : port);
          resolve();
        });
      }),
    stop: () =>
      new Promise((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}
