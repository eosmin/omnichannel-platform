module.exports = {
  displayName: 'worker',
  preset: '../../jest.preset.cjs',
  coverageDirectory: '../../coverage/apps/worker',
  // Needs Redis and Mailpit: run by the integration-tests job (jest.integration.config.cts)
  testPathIgnorePatterns: ['/node_modules/', '\\.integration\\.spec\\.ts$']
}
