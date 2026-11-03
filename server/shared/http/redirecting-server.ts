import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface RedirectingServer {
  readonly origin: string;
  readonly hits: readonly string[];
  close(): Promise<void>;
}

export async function startRedirectingServer(status: number): Promise<RedirectingServer> {
  const hits: string[] = [];
  const server = createServer((request, response) => {
    hits.push(`${request.method} ${request.url}`);
    response.writeHead(status, { location: `/followed${request.url ?? ''}` });
    response.end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    origin: `http://127.0.0.1:${port}`,
    hits,
    close: async () => {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
