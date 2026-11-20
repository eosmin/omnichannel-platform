// The specs that read the PLAN of a statement with row level security on (`rls-*-plan.spec.ts`). They take locks on the tables
// they measure (some hold ACCESS EXCLUSIVE until their rollback) and read the statistics of the planner, so they run in a process of
// their own, started fresh and after the shard of the suite, never next to the other specs of a shard. The security config leaves
// them out (`testPathIgnorePatterns`), so no spec runs twice or in neither. CI: a step of the last shard of `security-shards`
// (`pnpm test:rls-plan`); the enforced job does not run it: the specs assert a baseline with the policies off.
module.exports = {
  displayName: 'tests-rls-plan',
  preset: '../jest.preset.cjs',
  testEnvironment: '<rootDir>/helpers/test-environment.cjs',
  // By name, not by a glob: `rls-search-products-plan.spec.ts` asserts an index under a planner that its neighbours change when they run
  // before it in one process (it failed here and passed inside a shard), so it stays in the shards, as on main
  testMatch: [
    '<rootDir>/api/rls-inbox-webhooks-plan.spec.ts',
    '<rootDir>/api/rls-list-search-plan.spec.ts',
    '<rootDir>/api/rls-order-search-plan.spec.ts',
    '<rootDir>/api/rls-search-plan.spec.ts'
  ],
  setupFiles: ['<rootDir>/helpers/env.ts'],
  // Closes the connections of createWorkerPrisma when a file ends
  setupFilesAfterEnv: ['<rootDir>/helpers/worker-db-teardown.ts'],
  testTimeout: 30_000
}
