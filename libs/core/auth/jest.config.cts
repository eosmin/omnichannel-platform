module.exports = {
  displayName: 'core-auth',
  preset: '../../../jest.preset.cjs',
  coverageDirectory: '../../../coverage/libs/core/auth',
  // Auth and authorization is a critical path of TDD_13 section 9: 95%
  coverageThreshold: {
    global: { lines: 95, functions: 95, statements: 95, branches: 95 }
  }
}
