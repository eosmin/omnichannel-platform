module.exports = {
  displayName: 'worker-integration',
  preset: '../../jest.preset.cjs',
  setupFiles: ['<rootDir>/src/testing/load-env.ts'],
  testMatch: ['<rootDir>/**/*.integration.spec.ts'],
  testTimeout: 30_000
}
