module.exports = {
  displayName: 'contracts',
  preset: '../jest.preset.cjs',
  // The contract suites of the plugins: pure code, no database and no app
  testMatch: ['<rootDir>/contracts/**/*.spec.ts'],
  testTimeout: 30_000
}
