module.exports = {
  displayName: 'core-redis',
  preset: '../../../jest.preset.cjs',
  coverageDirectory: '../../../coverage/libs/core/redis',
  // Needs Redis: run by the integration-tests job (jest.integration.config.cts)
  testPathIgnorePatterns: ['/node_modules/', '\\.integration\\.spec\\.ts$']
}
