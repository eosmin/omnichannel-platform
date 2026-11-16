module.exports = {
  displayName: 'tests',
  preset: '../jest.preset.cjs',
  // Prints the last answers of the api when a test fails (see the file)
  testEnvironment: '<rootDir>/helpers/test-environment.cjs',
  // The suites that need the whole system (Postgres, Redis and the app of the api): they are a
  // gate of their own in CI (the security-tests check, which waits for its shards), not part of the unit tests. security/ is the
  // isolation gate; api/ is the behaviour of the endpoints, through the same app.
  testMatch: ['<rootDir>/security/**/*.spec.ts', '<rootDir>/api/**/*.spec.ts'],
  // The latency spec measures the answer of the api, so it needs a process of its own: after the other specs of a
  // shard the heap of the process is at its limit (3.6 of 4 GB) and the major collections of 300-950 ms land in
  // the measurement. `jest.latency.config.cts` runs it (`pnpm test:latency`)
  testPathIgnorePatterns: ['/node_modules/', '<rootDir>/api/products-search-performance.spec.ts'],
  // The env of the app is read when it is imported: this runs before any suite does
  setupFiles: ['<rootDir>/helpers/env.ts'],
  testTimeout: 30_000
}
