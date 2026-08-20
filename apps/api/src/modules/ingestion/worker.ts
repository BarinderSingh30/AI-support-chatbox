import { claimNextJob, completeJob, failJob, reclaimStalled } from './queue.ts';
import { processJob } from './pipeline.ts';
import type { PipelineDeps } from './pipeline.ts';

const STALE_AFTER_MS = 10 * 60_000;

export interface Worker {
  /** Called after enqueue. Starts a drain if one is not already running. */
  notify(): void;
  /** Requeues work abandoned by a previous process. Run once at startup. */
  recover(): Promise<number>;
  drained(): Promise<void>;
}

/**
 * Trigger-on-enqueue worker, deliberately without a polling loop.
 *
 * A conventional Postgres queue polls every couple of seconds, which keeps the
 * database compute permanently awake. On Neon's free tier that burns the whole
 * monthly CU-hour allowance in about sixteen days. Here nothing runs on a timer:
 * the queue is drained when work arrives and when the process boots, so an idle
 * system lets Postgres suspend.
 */
export function createWorker(deps: PipelineDeps, workerId = `w-${process.pid}`): Worker {
  let draining: Promise<void> | null = null;

  async function drain() {
    for (;;) {
      const job = await claimNextJob(workerId);
      if (!job) return;
      try {
        await processJob(job, deps);
        await completeJob(job.id);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await failJob(job.id, message);
      }
    }
  }

  return {
    notify() {
      if (draining) return;
      draining = drain()
        .catch(() => {})
        .finally(() => {
          draining = null;
        });
    },
    async recover() {
      const reclaimed = await reclaimStalled(STALE_AFTER_MS);
      if (reclaimed > 0) this.notify();
      return reclaimed;
    },
    async drained() {
      while (draining) await draining;
    },
  };
}
