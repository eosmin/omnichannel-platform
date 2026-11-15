module.exports = {
  displayName: 'core-finance',
  preset: '../../../jest.preset.cjs',
  coverageDirectory: '../../../coverage/libs/core/finance',
  // A critical path of the platform (TDD_13 §1, §9): the pure rules of an entry, its hash chain, the periods and the
  // chart are tested to the line. The posting service needs a database and is covered by the integration suites
  // (tests/api/finance-*.spec.ts, tests/security/finance-schema.spec.ts).
  collectCoverageFrom: [
    'src/entry-rules.ts',
    'src/ledger-hash.ts',
    'src/period-rules.ts',
    'src/account-rules.ts',
    'src/templates/*.ts'
  ],
  coverageThreshold: { global: { lines: 90, branches: 85 } }
}
