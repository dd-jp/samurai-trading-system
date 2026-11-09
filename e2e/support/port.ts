import { createServer } from 'node:net';

function acquireFreePort(host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, host, () => {
      const address = probe.address();
      const port = typeof address === 'object' && address !== null ? address.port : null;
      probe.close((closeErr) => {
        if (closeErr) {
          reject(closeErr);
        } else if (port === null) {
          reject(new Error('acquireFreePort: OS returned no usable port'));
        } else {
          resolve(port);
        }
      });
    });
  });
}

function parseConfiguredPort(portEnv: string, configured: string): number {
  const port = Number(configured);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(
      `resolveE2ePort: ${portEnv}="${configured}" is not a valid port; unset it and rerun`,
    );
  }
  return port;
}

export async function resolveE2ePort(host: string, portEnv: string): Promise<number> {
  const configured = process.env[portEnv] ?? '';
  if (configured !== '') return parseConfiguredPort(portEnv, configured);
  const port = await acquireFreePort(host);
  process.env[portEnv] = String(port);
  return port;
}
