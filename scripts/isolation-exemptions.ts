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
  AnalyticsEvent: {
    step: '5.4',
    reason:
      'Written by the pipelines; nothing reads it yet. The reports read the rollups, not the events. Its case goes with its first reader (the zero-result search report) or with its retention purge, whichever the step builds first'
  },
  AuditLog: { step: '7.2', reason: 'Read through the audit log viewer of the organization' },
  ConsentRecord: { step: '7.2', reason: 'Written by the compliance flows' },
  DataSubjectRequest: { step: '7.2', reason: 'Created by the data subject request flow' },
  RetentionSettings: { step: '5.4', reason: 'Read and changed from the data retention settings' }
}
