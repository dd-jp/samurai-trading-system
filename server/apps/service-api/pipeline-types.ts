/**
 * Re-export shim. The Pipeline view's wire model now lives in
 * `contracts/pipeline.ts`.
 *
 * It moved because the browser renders every shape in it, and importing them
 * from `server/apps/service-api/` meant the client's TypeScript program included backend
 * source — the whole file was already a frozen contract between the query
 * layer and the render layer, so `contracts/` is simply where that contract
 * belongs. Nothing in it changed except where `AssetClass` comes from.
 *
 * This shim exists so the ~12 server-side import sites did not have to churn
 * in the same commit. It is deleted when the tree moves to `client/` +
 * `server/` and those sites point at `contracts/` directly.
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
