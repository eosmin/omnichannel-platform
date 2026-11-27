import type { IsolationExemption } from './lib/isolation'

// The models with a store_id that have no case in the tenant isolation suite yet, because the
// platform has no endpoint for them yet. Each one names the step of the plan that builds it:
// check-isolation-coverage fails as soon as that step is `done` in the progress table of
// docs/IMPLEMENTATION_PLAN.md and the model is still here, so the case is added when the resource
// is built and not "later". The step that builds a resource deletes its line and adds its case to
// tests/security/tenant-isolation.spec.ts (CLAUDE.md, rule 3). A step that is delivered in several PRs
// (2.3) removes the line of each model with the PR that builds its endpoint, not with the last one.
//
// The shipping tables of Step 4.8 PR B1 (TDD_17 §2) are schema only: until a route reaches them their
// isolation is proved by tests/security/shipping-schema.spec.ts (the database refuses a link across
// stores, even of the same organization). The plan lists which PR removes which line (Step 4.8, "Left by PR B1").

export const ISOLATION_EXEMPTIONS: Readonly<Record<string, IsolationExemption>> = {
  FiscalDelivery: {
    step: '4B.7',
    reason:
      'No route reads or changes it yet: the delivery is written by the api itself when a document is accepted, and the action of the panel that reads it and hands the files over is PR D13b-2, which deletes this line and adds its case. Until then its isolation is the organization policy of the table (listed in PHASE_4_TABLES of tests/security/rls-finance-isolation.spec.ts) and the unit spec of FiscalDeliveryService, whose every read and write runs in the organization of the document'
  },
  PluginIdempotencyKey: {
    step: '7.3',
    reason:
      'No route of a person reads or changes it (the plugin API reaches it only with the key of its own installation), so the checks of the table, which go through such a route, cannot run. Its isolation is the block "the idempotency keys of the plugin API" of tests/security/tenant-isolation.spec.ts, the policy of the table (tests/security/rls-*.spec.ts) and the unique key per installation'
  }
}
