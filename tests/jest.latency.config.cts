// The specs that measure how long the api takes to answer. They run in a process of their own, started fresh
// (CI: a step after the security shards, `pnpm test:latency`): in the process of a shard, after dozens of specs, the
// heap is at its limit and the garbage collections of the process are what the measurement reads. The security
// config leaves them out (`testPathIgnorePatterns`), so no spec runs twice or in neither.
module.exports = {
  displayName: 'tests-latency',
  preset: '../jest.preset.cjs',
  testEnvironment: '<rootDir>/helpers/test-environment.cjs',
  testMatch: ['<rootDir>/api/products-search-performance.spec.ts'],
  setupFiles: ['<rootDir>/helpers/env.ts'],
  testTimeout: 30_000
}
