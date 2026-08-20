import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // These are integration tests against one real database. Running files in
    // parallel lets one file's queued jobs be claimed by another file's worker,
    // because the queue is deliberately cross-tenant.
    fileParallelism: false,
  },
});
