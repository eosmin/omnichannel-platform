// The suites that depend on what a transaction does to the connection it runs on (transaction-local
// settings for the tenant, row locks, advisory locks), run with the api and the worker connecting through
// PgBouncer in transaction mode: TEST_POOLER_URL is required (CI starts the compose stack, a laptop has
// it up). pooler/ is about the pooler itself; the others are the specs that take those locks.
module.exports = {
  displayName: 'tests-pooler',
  preset: '../jest.preset.cjs',
  testEnvironment: '<rootDir>/helpers/test-environment.cjs',
  testMatch: [
    '<rootDir>/pooler/**/*.spec.ts',
    '<rootDir>/security/tenant-isolation.spec.ts',
    '<rootDir>/api/customers-store-lock.spec.ts',
    '<rootDir>/api/orders.spec.ts',
    '<rootDir>/api/transfers.spec.ts',
    '<rootDir>/api/settings.spec.ts',
    // The ones that reach a lock through another door: the stock engine, the order lifecycle, the remittances,
    // and the worker's carrier events and analytics rollup (advisory locks)
    '<rootDir>/api/inventory-engine.spec.ts',
    '<rootDir>/api/orders-lifecycle.spec.ts',
    '<rootDir>/api/remittances.spec.ts',
    '<rootDir>/api/carrier-event-processing.spec.ts',
    '<rootDir>/api/analytics-rollups.spec.ts'
  ],
  setupFiles: ['<rootDir>/helpers/env.ts'],
  testTimeout: 30_000
}
