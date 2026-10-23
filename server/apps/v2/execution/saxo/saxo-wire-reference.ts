import { createHash } from 'node:crypto';

// Saxo caps ExternalReference at 50 characters: 40 hex plus ':target' leaves room
const REFERENCE_HEX_CHARS = 40;

export function saxoWireReference(clientOrderId: string): string {
  return createHash('sha256').update(clientOrderId).digest('hex').slice(0, REFERENCE_HEX_CHARS);
}
