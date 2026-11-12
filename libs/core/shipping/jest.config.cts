module.exports = {
  displayName: 'core-shipping',
  preset: '../../../jest.preset.cjs',
  coverageDirectory: '../../../coverage/libs/core/shipping',
  // A critical path of the platform (TDD_13 §1, §9). The pure files are tested to the line; the ones that touch the
  // database or the bucket (the guide numbering, the engine and what it reads and writes) are covered by the integration
  // suites (tests/api/shipments.spec.ts, and tests/api/shipment-status-engine.spec.ts for the status engine).
  collectCoverageFrom: [
    'src/**/*.ts',
    '!src/**/*.spec.ts',
    '!src/index.ts',
    '!src/guide-numbering.ts',
    '!src/shipment-labels.ts',
    '!src/shipment-prepare.ts',
    '!src/shipment-status-engine.ts',
    '!src/shipment-writes.ts',
    // Reads and writes the history inside a transaction: tests/api/carrier-event-processing.spec.ts covers it
    '!src/shipment-replay.ts',
    '!src/shipping.service.ts',
    // The void of a guide: reads and writes the shipment and its pickup inside transactions and calls the carrier. Covered by
    // tests/api/shipment-cancellation.spec.ts
    '!src/shipment-cancellation.ts',
    // The settlement of the cash collected on delivery: reads and writes the remittance and its shipments inside one transaction
    // under a lock. Covered by tests/api/remittances.spec.ts
    '!src/remittances.service.ts'
  ],
  coverageThreshold: { global: { lines: 90, branches: 85 } }
}
