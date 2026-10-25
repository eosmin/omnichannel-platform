module.exports = {
  displayName: 'tests',
  preset: '../jest.preset.cjs',
  // The suites that need the whole system (Postgres, Redis and the app of the api): they are a
  // gate of their own in CI (the security-tests job), not part of the unit tests
  testMatch: ['<rootDir>/security/**/*.spec.ts'],
  // The env of the app is read when it is imported: this runs before any suite does
  setupFiles: ['<rootDir>/helpers/env.ts'],
  testTimeout: 30_000
}
