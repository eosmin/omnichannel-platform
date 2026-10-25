module.exports = {
  displayName: 'api',
  preset: '../../jest.preset.cjs',
  coverageDirectory: '../../coverage/apps/api',
  // Needs Postgres and Redis: run by the integration-tests job (jest.integration.config.cts)
  testPathIgnorePatterns: ['/node_modules/', '\\.integration\\.spec\\.ts$']
}
