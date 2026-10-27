import { defineConfig } from 'vitest/config';

/** The business tests again, on the phone app's stack (see test/helpers.ts). */
export default defineConfig({
  test: {
    env: { TULA_TEST_PHONE: '1' },
    testTimeout: 30_000,
    include: [
      'test/bills.test.ts', 'test/m1.test.ts', 'test/sales-ops.test.ts', 'test/purchases.test.ts',
      'test/reports.test.ts', 'test/day-book.test.ts', 'test/shop-day.test.ts', 'test/excel.test.ts', 'test/masters-extra.test.ts',
      'test/quotes.test.ts',
    ],
  },
});
