/**
 * CLI Run Modes (#99, docs/specs/cli-spec.md "Module: Run Modes"):
 * `runOnce` (`samurai status`) and `runWatch` (`samurai watch [--interval]`),
 * composing the four `CLIViews` render functions over a `QueryStore`.
 */
import type { CLIViews, QueryStore } from './types.js';

export function runOnce(views: CLIViews, store: QueryStore): void {
  const asOf = new Date();
  console.log(views.renderPositions(store, asOf));
  console.log(views.renderDebates(store, asOf));
  console.log(views.renderVerdicts(store, asOf));
  console.log(views.renderPerformance(store, asOf));
}

export function runWatch(views: CLIViews, store: QueryStore, intervalMs: number): void {
  console.clear();
  runOnce(views, store);
  setInterval(() => {
    console.clear();
    runOnce(views, store);
  }, intervalMs);
}
