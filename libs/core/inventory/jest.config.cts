module.exports = {
  displayName: 'core-inventory',
  preset: '../../../jest.preset.cjs',
  coverageDirectory: '../../../coverage/libs/core/inventory',
  // A critical path of the platform (TDD_13 §1, §9): the pure rules of a movement and of a transfer are tested to the line. The service
  // itself needs a database and is covered by the integration suites (tests/api/inventory-*.spec.ts).
  collectCoverageFrom: ['src/movement-math.ts', 'src/transfer-rules.ts'],
  coverageThreshold: { global: { lines: 90, branches: 85 } }
}
