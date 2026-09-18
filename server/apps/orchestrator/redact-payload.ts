import { maskCredentials } from '../../shared/index.js';

const CREDENTIAL_KEYS: ReadonlySet<string> = new Set([
  'accesskey',
  'accesskeyid',
  'accesstoken',
  'alpacakeyid',
  'alpacasecretkey',
  'apikey',
  'apikeyid',
  'apisecret',
  'apitoken',
  'apcaapikeyid',
  'apcaapisecretkey',
  'auth',
  'authorization',
  'authtoken',
  'bearertoken',
  'bottoken',
  'clientsecret',
  'cookie',
  'credential',
  'credentials',
  'idtoken',
  'passwd',
  'password',
  'polygonapikey',
  'privatekey',
  'pwd',
  'refreshtoken',
  'secret',
  'secretaccesskey',
  'secretkey',
  'sessiontoken',
  'signingsecret',
  'token',
  'webhooksecret',
]);

const REDACTED = '[REDACTED]';

const MAX_DEPTH = 6;

const MAX_NODES = 2_000;

function isCredentialKey(key: string): boolean {
  return CREDENTIAL_KEYS.has(key.toLowerCase().replace(/[-_\s]/g, ''));
}

interface WalkBudget {
  visited: number;
}

type Walk = (value: unknown, depth: number) => unknown;

function isUnmaskablePrimitive(value: unknown): boolean {
  return value === null || typeof value !== 'object';
}

function walkArray(value: unknown[], depth: number, budget: WalkBudget, walk: Walk): unknown[] {
  const items: unknown[] = [];
  for (const item of value) {
    if (budget.visited >= MAX_NODES) {
      items.push('[REDACTION_TRUNCATED]');
      break;
    }
    items.push(walk(item, depth + 1));
  }
  return items;
}

function renderSpecialObject(value: object): unknown | undefined {
  if (value instanceof Error) return maskCredentials(`${value.name}: ${value.message}`);
  if (value instanceof Date) return value.toISOString();
  return undefined;
}

function walkObject(
  value: Record<string, unknown>,
  depth: number,
  budget: WalkBudget,
  walk: Walk,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (budget.visited >= MAX_NODES) {
      out['[REDACTION_TRUNCATED]'] = true;
      break;
    }
    out[key] = isCredentialKey(key) ? REDACTED : walk(item, depth + 1);
  }
  return out;
}

export function redactPayload(payload: unknown): unknown {
  const budget: WalkBudget = { visited: 0 };

  const walk: Walk = (value, depth) => {
    if (budget.visited >= MAX_NODES) return '[REDACTION_TRUNCATED]';
    budget.visited += 1;

    if (typeof value === 'string') return maskCredentials(value);
    if (isUnmaskablePrimitive(value)) return value;
    if (depth >= MAX_DEPTH) return '[REDACTION_DEPTH_LIMIT]';

    if (Array.isArray(value)) return walkArray(value, depth, budget, walk);

    const special = renderSpecialObject(value as object);
    if (special !== undefined) return special;

    return walkObject(value as Record<string, unknown>, depth, budget, walk);
  };

  return walk(payload, 0);
}
