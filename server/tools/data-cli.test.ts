import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ingestTiingoHistory = vi.fn();
const backfillFromEnvironment = vi.fn();

vi.mock('./ingest-tiingo-history.js', () => ({
  ingestTiingoHistory: (...args: unknown[]) => ingestTiingoHistory(...args),
}));
vi.mock('./backfill-market-data.js', () => ({
  runFromEnvironment: (...args: unknown[]) => backfillFromEnvironment(...args),
}));

const { main } = await import('./data-cli.js');

describe('data-cli main', () => {
  const originalTiingoKey = process.env.TIINGO_API_KEY;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    process.env.TIINGO_API_KEY = 'test-key';
    process.exitCode = undefined;
    ingestTiingoHistory.mockReset();
    backfillFromEnvironment.mockReset();
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    process.env.TIINGO_API_KEY = originalTiingoKey;
    process.exitCode = undefined;
    logSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it('prints usage and sets exitCode 1 when no command is given', async () => {
    await main(['node', 'data-cli.js']);
    expect(logSpy).toHaveBeenCalledOnce();
    expect(process.exitCode).toBe(1);
  });

  it.each(['--help', '-h'])('prints usage and sets exitCode 0 for %s', async (flag) => {
    await main(['node', 'data-cli.js', flag]);
    expect(logSpy).toHaveBeenCalledOnce();
    expect(process.exitCode).toBe(0);
  });

  it('errors and sets exitCode 1 for an unknown command', async () => {
    await main(['node', 'data-cli.js', 'not-a-command']);
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('Unknown command "not-a-command"'),
    );
    expect(process.exitCode).toBe(1);
  });

  it('runs backfill-market-data and leaves exitCode unset on success', async () => {
    backfillFromEnvironment.mockResolvedValue(undefined);
    await main(['node', 'data-cli.js', 'backfill-market-data']);
    expect(backfillFromEnvironment).toHaveBeenCalledOnce();
    expect(process.exitCode).toBeUndefined();
  });

  it('runs ingest-history and leaves exitCode unset on success', async () => {
    ingestTiingoHistory.mockResolvedValue(undefined);
    await main(['node', 'data-cli.js', 'ingest-history']);
    expect(ingestTiingoHistory).toHaveBeenCalledOnce();
    expect(process.exitCode).toBeUndefined();
  });

  it('catches a thrown error and sets exitCode 1', async () => {
    backfillFromEnvironment.mockRejectedValue(new Error('boom'));
    await main(['node', 'data-cli.js', 'backfill-market-data']);
    expect(errorSpy).toHaveBeenCalledWith('backfill-market-data failed: boom');
    expect(process.exitCode).toBe(1);
  });
});
