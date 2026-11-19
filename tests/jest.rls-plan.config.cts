// The specs that read the PLAN of a statement with row level security on (`rls-*-plan.spec.ts`). They take locks on the tables
// they measure (some hold ACCESS EXCLUSIVE until their rollback) and read the statistics of the planner, so they run in a process of
// their own, started fresh and after the shard of the suite, never next to the other specs of a shard. The security config leaves
// them out (`testPathIgnorePatterns`), so no spec runs twice or in neither. CI: a step of the last shard, in `security-shards`
// and in `rls-enforced-security` (`pnpm test:rls-plan`).
module.exports = {
  displayName: 'tests-rls-plan',
  preset: '../jest.preset.cjs',
  testEnvironment: '<rootDir>/helpers/test-environment.cjs',
  testMatch: ['<rootDir>/api/rls-*-plan.spec.ts'],
  setupFiles: ['<rootDir>/helpers/env.ts'],
  // Closes the connections of createWorkerPrisma when a file ends
  setupFilesAfterEnv: ['<rootDir>/helpers/worker-db-teardown.ts'],
  testTimeout: 30_000
}
