module.exports = {
  displayName: 'core-database',
  preset: '../../../jest.preset.cjs',
  coverageDirectory: '../../../coverage/libs/core/database',
  // Needs a migrated database: run by the integration-tests job (jest.integration.config.cts)
  testPathIgnorePatterns: ['/node_modules/', '\\.integration\\.spec\\.ts$']
}
