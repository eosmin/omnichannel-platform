module.exports = {
  displayName: 'core-redis-integration',
  preset: '../../../jest.preset.cjs',
  testMatch: ['<rootDir>/**/*.integration.spec.ts'],
  testTimeout: 30_000,
  // The cache decides what a request may see (the tenant context lives in it) and the rate limit
  // protects the login: both are held to every line. Branches: 90, because TypeScript emits some for
  // the constructor parameters that no test can take.
  collectCoverageFrom: ['src/cache.service.ts', 'src/redis-throttler.storage.ts'],
  coverageThreshold: {
    global: { lines: 100, functions: 100, statements: 100, branches: 90 }
  }
}
