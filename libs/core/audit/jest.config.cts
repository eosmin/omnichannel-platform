module.exports = {
  displayName: 'core-audit',
  preset: '../../../jest.preset.cjs',
  coverageDirectory: '../../../coverage/libs/core/audit',
  // Needs Postgres: run by the integration-tests job (jest.integration.config.cts)
  testPathIgnorePatterns: ['/node_modules/', '\\.integration\\.spec\\.ts$'],
  // The module only wires providers. The audit trail proves who did what, so what it records is held
  // to the bar of the other security code: every line, and the branches that a test can take (the rest
  // are the ones TypeScript emits for injected constructor parameters).
  collectCoverageFrom: ['src/**/*.ts', '!**/*.spec.ts', '!**/*.module.ts', '!**/index.ts'],
  coverageThreshold: {
    global: { lines: 95, functions: 95, statements: 95, branches: 85 }
  }
}
