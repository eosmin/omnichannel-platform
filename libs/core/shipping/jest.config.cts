module.exports = {
  displayName: 'core-shipping',
  preset: '../../../jest.preset.cjs',
  coverageDirectory: '../../../coverage/libs/core/shipping',
  // A critical path of the platform (TDD_13 §1, §9). The pure files are tested to the line; the ones that touch the
  // database or the bucket (the guide numbering, the engine and what it reads and writes) are covered by the integration
  // suites (tests/api/shipments.spec.ts).
  collectCoverageFrom: [
    'src/**/*.ts',
    '!src/**/*.spec.ts',
    '!src/index.ts',
    '!src/guide-numbering.ts',
    '!src/shipment-labels.ts',
    '!src/shipment-prepare.ts',
    '!src/shipment-writes.ts',
    '!src/shipping.service.ts'
  ],
  coverageThreshold: { global: { lines: 90, branches: 85 } }
}
