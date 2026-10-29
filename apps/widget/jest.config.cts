module.exports = {
  displayName: 'widget',
  preset: '../../jest.preset.cjs',
  // The script runs in a page: the specs need a DOM
  testEnvironment: 'jest-environment-jsdom',
  transform: {
    '^.+\\.[tj]sx?$': ['ts-jest', { tsconfig: '<rootDir>/tsconfig.spec.json' }]
  },
  coverageDirectory: '../../coverage/apps/widget'
}
