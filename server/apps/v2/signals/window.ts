import type { SignalSessionWire } from '../../../../contracts/index.js';

export interface SessionCalendar {
  isOpen(instant: Date): boolean;
  nextSessionOpen(instant: Date): Date;
}

export interface SignalWindow {
  readonly session: SignalSessionWire;
  readonly processAfter: Date;
}

export function classifySignalWindow(receivedAt: Date, calendar: SessionCalendar): SignalWindow {
  if (calendar.isOpen(receivedAt)) return { session: 'in_session', processAfter: receivedAt };
  return { session: 'out_of_session', processAfter: calendar.nextSessionOpen(receivedAt) };
}
