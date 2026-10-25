const path = require('node:path')
const nxPreset = require('@nx/jest/preset').default

module.exports = {
  ...nxPreset,
  testEnvironment: 'node',
  transform: {
    '^.+\\.[tj]sx?$': ['ts-jest', { tsconfig: path.join(__dirname, 'tsconfig.spec.json') }]
  },
  moduleFileExtensions: ['ts', 'tsx', 'js', 'jsx'],
  // Count every source file, not only the ones a test happens to load: a file nobody tests must
  // lower the number, or a threshold means nothing
  collectCoverageFrom: [
    'src/**/*.{ts,tsx}',
    '!**/*.spec.{ts,tsx}',
    '!**/*.d.ts',
    '!**/index.ts',
    '!**/testing/**'
  ]
}
