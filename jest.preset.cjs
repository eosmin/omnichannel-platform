const path = require('node:path')
const nxPreset = require('@nx/jest/preset').default

module.exports = {
  ...nxPreset,
  testEnvironment: 'node',
  transform: {
    '^.+\\.[tj]sx?$': ['ts-jest', { tsconfig: path.join(__dirname, 'tsconfig.spec.json') }]
  },
  moduleFileExtensions: ['ts', 'tsx', 'js', 'jsx']
}
