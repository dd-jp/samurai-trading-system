import type { Logger } from '../../shared/index.js';
import { exitCodeOrOne, isMainModule } from '../../tools/cli-entrypoint.js';
import {
  backupTargets,
  type CommandRunner,
  execRunner,
  litestreamFor,
  replicateOnce,
  restoreMissing,
} from './backup.js';
import { V2_STORE_PATH } from './index.js';

const STDERR_LOGGER: Logger = {
  log: (entry) => {
    process.stderr.write(`${JSON.stringify(entry)}\n`);
  },
};

export async function main(
  argv: readonly string[],
  env: NodeJS.ProcessEnv,
  run: CommandRunner = execRunner,
  logger: Logger = STDERR_LOGGER,
): Promise<number> {
  const [command] = argv;
  if (command !== 'backup' && command !== 'restore') {
    process.stderr.write('usage: backup-cli backup | restore\n');
    return 1;
  }
  const tool = litestreamFor(env, run);
  const targets = backupTargets(V2_STORE_PATH, env);
  if (command === 'backup') await replicateOnce(tool, targets, logger);
  else await restoreMissing(tool, targets, logger);
  return 0;
}

if (isMainModule(import.meta.url)) {
  process.exitCode = await exitCodeOrOne(main(process.argv.slice(2), process.env));
}
