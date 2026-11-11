module.exports = {
  displayName: 'core-shipping',
  preset: '../../../jest.preset.cjs',
  coverageDirectory: '../../../coverage/libs/core/shipping',
  // A critical path of the platform (TDD_13 §1, §9). The pure files are tested to the line; the ones that touch the
  // database (the guide numbering) are covered by the integration suites.
  collectCoverageFrom: [
    'src/**/*.ts',
    '!src/**/*.spec.ts',
    '!src/index.ts',
    '!src/guide-numbering.ts'
  ],
  coverageThreshold: { global: { lines: 90, branches: 85 } }
}
