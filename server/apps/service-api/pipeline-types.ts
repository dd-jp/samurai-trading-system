/**
 * Re-export shim. The Pipeline view's wire model now lives in
 * `contracts/pipeline.ts`.
 *
 * It moved because the browser renders every shape in it, and importing them
 * from `src/dashboard/` (this file's home at the time) meant the client's
 * TypeScript program included backend source — the whole file was already a
 * frozen contract between the query layer and the render layer, so
 * `contracts/` is simply where that contract belongs. Nothing in it changed
 * except where `AssetClass` comes from.
 *
 * This shim exists so the server-side import sites did not have to churn in
 * the same commit as the move. There are four — `pipeline-query.ts`,
 * `pipeline-query.test.ts`, `sqlite-query-store.ts`, `fixture-store.ts`, all
 * in this directory — so retiring it is four edits, not a project. It retires
 * when they import `contracts/pipeline.js` directly and nothing references
 * this file: `grep -rn 'pipeline-types' server/` is the check.
 */

export {
  PIPELINE_STAGES,
  type PipelineCell,
  type PipelineCellState,
  type PipelineLane,
  type PipelineOutcome,
  type PipelineStage,
  type PipelineView,
} from '../../../contracts/pipeline.js';
