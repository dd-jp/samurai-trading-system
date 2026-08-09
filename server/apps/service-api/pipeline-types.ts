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
 * This shim exists so the ~12 server-side import sites did not have to churn
 * in the same commit as the move. It is deliberately still here: repointing
 * those sites is a mechanical follow-up worth doing on its own, where the
 * diff is legible, rather than buried in a tree-wide rename. It retires when
 * they import `contracts/pipeline.js` directly and nothing references this
 * file — `grep -rn 'service-api/pipeline-types' server/` is the check.
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
