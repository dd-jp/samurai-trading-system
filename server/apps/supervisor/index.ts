import { pathToFileURL } from 'node:url';
import { JsonLogger } from '../orchestrator/index.js';
import { installSupervisorContinueOnFault, watchSupervisorStdout } from './fault-guard.js';
import { startSupervisor } from './supervisor.js';

export { installSupervisorContinueOnFault, watchSupervisorStdout };

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  watchSupervisorStdout();

  new JsonLogger().log({
    trace_id: 'startup',
    stage: 'supervisor',
    level: 'info',
    message: 'Samurai serve → starting orchestrator + dashboard. Ctrl+C to stop both.',
  });

  let supervisor: ReturnType<typeof startSupervisor>;
  try {
    supervisor = startSupervisor();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }

  installSupervisorContinueOnFault();

  process.on('SIGINT', () => supervisor.shutdown('SIGINT'));
  process.on('SIGTERM', () => supervisor.shutdown('SIGTERM'));

  process.exit(await supervisor.done);
}
