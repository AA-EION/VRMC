import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    poolOptions: {
      // --expose-gc lets the allocation regression test force a collection
      // before and after measuring, so the figure it reads is retained heap
      // rather than whatever happened not to have been collected yet.
      forks: { execArgv: ['--expose-gc'] },
      threads: { execArgv: ['--expose-gc'] },
    },
  },
});
