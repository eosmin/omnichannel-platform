module.exports = {
  displayName: 'tests',
  preset: '../jest.preset.cjs',
  // Prints the last answers of the api when a test fails (see the file)
  testEnvironment: '<rootDir>/helpers/test-environment.cjs',
  // The suites that need the whole system (Postgres, Redis and the app of the api): they are a
  // gate of their own in CI (the security-tests job), not part of the unit tests. security/ is the
  // isolation gate; api/ is the behaviour of the endpoints, through the same app.
  testMatch: ['<rootDir>/security/**/*.spec.ts', '<rootDir>/api/**/*.spec.ts'],
  // The env of the app is read when it is imported: this runs before any suite does
  setupFiles: ['<rootDir>/helpers/env.ts'],
  testTimeout: 30_000
}
