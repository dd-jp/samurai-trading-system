import type { ControlAction, ControlReader, ManualControl } from '../../../../contracts/index.js';
import type { StoreHandle } from '../../../shared/store/index.js';

const STATE_AFTER = { pause: 'paused', halt: 'halted' } as const;

interface ControlRow {
  action: ControlAction;
  reason: string;
  set_at: string;
}

export class ControlStore implements ControlReader {
  constructor(private readonly db: StoreHandle) {}

  current(): ManualControl {
    const row = this.db
      .prepare('SELECT action, reason, set_at FROM v2_controls ORDER BY control_id DESC LIMIT 1')
      .get() as ControlRow | undefined;
    if (row === undefined || row.action === 'resume') return { state: 'running' };
    return { state: STATE_AFTER[row.action], reason: row.reason, setAt: row.set_at };
  }
}
