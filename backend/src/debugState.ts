/**
 * Global debug state for the pipeline.
 * Exposed via the /debug endpoint to diagnose issues remotely.
 */
export const pipelineState = {
  crawlerStartedAt: null as string | null,
  crawlerLastPoll: null as string | null,
  crawlerLastBlock: 0,
  crawlerChainTip: 0,
  blocksProcessed: 0,
  blobEventsFound: 0,
  blobsInserted: 0,
  blobInsertErrors: 0,
  alphaSignalsGenerated: 0,
  sseBroadcasts: 0,
  lastError: null as string | null,
  errors: [] as string[],
};

export function recordError(label: string, err: unknown): void {
  const msg = `[${label}] ${err instanceof Error ? err.message : String(err)}`;
  pipelineState.lastError = msg;
  pipelineState.errors.push(msg);
  // Keep only last 20 errors
  if (pipelineState.errors.length > 20) {
    pipelineState.errors = pipelineState.errors.slice(-20);
  }
}
