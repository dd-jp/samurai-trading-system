import { readTokenFile, tokenFilePath } from '../../../pipeline/execution/index.js';

const ENVIRONMENTS = ['sim', 'live'] as const;

function tokensIn(environment: (typeof ENVIRONMENTS)[number]): { name: string; value: string }[] {
  try {
    const record = readTokenFile(tokenFilePath(environment));
    if (record === undefined) return [];
    return [
      { name: `saxo-tokens/${environment}.json accessToken`, value: record.accessToken },
      { name: `saxo-tokens/${environment}.json refreshToken`, value: record.refreshToken },
    ];
  } catch {
    return [];
  }
}

export function saxoTokenSecrets(): { name: string; value: string }[] {
  return ENVIRONMENTS.flatMap(tokensIn);
}
