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

export async function resolveE2ePort(host: string, portEnv: string): Promise<number> {
  const existing = process.env[portEnv];
  if (existing !== undefined && existing !== '') {
    const port = Number(existing);
    if (!Number.isInteger(port) || port < 1 || port > 65_535) {
      throw new Error(
        `resolveE2ePort: ${portEnv}="${existing}" is not a valid port; unset it and rerun`,
      );
    }
    return port;
  }
  const port = await acquireFreePort(host);
  process.env[portEnv] = String(port);
  return port;
}
