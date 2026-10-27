import { defineConfig } from 'vitest/config';

// Whole-shop-day tests take a few seconds; on a cold or busy machine (a fresh CI runner, the first run after a
// change) they passed the 5 s default and failed for no real reason.
export default defineConfig({ test: { testTimeout: 30_000 } });
