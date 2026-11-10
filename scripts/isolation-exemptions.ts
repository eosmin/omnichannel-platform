import type { IsolationExemption } from './lib/isolation'

// The models with a store_id that have no case in the tenant isolation suite yet, because the
// platform has no endpoint for them yet. Each one names the step of the plan that builds it:
// check-isolation-coverage fails as soon as that step is `done` in the progress table of
// docs/IMPLEMENTATION_PLAN.md and the model is still here, so the case is added when the resource
// is built and not "later". The step that builds a resource deletes its line and adds its case to
// tests/security/tenant-isolation.spec.ts (CLAUDE.md, rule 3). A step that is delivered in several PRs
// (2.3) removes the line of each model with the PR that builds its endpoint, not with the last one.
export const ISOLATION_EXEMPTIONS: Readonly<Record<string, IsolationExemption>> = {
  AnalyticsEvent: {
    step: '5.2',
    reason: 'Written by the pipelines and read only through the analytics queries'
  },
  ApiKey: { step: '5.4', reason: 'Created and revoked from Settings' },
  AuditLog: { step: '7.2', reason: 'Read through the audit log viewer of the organization' },
  ConsentRecord: { step: '7.2', reason: 'Written by the compliance flows' },
  DataSubjectRequest: { step: '7.2', reason: 'Created by the data subject request flow' },
  MetricDaily: { step: '5.2', reason: 'Read only through the analytics queries' },
  MetricHourly: { step: '5.2', reason: 'Read only through the analytics queries' },
  Order: { step: '4.3', reason: 'Has no endpoint yet' },
  OrderItemAllocation: {
    step: '4.3',
    reason: 'Written when an order is created and read with it: the orders have no endpoint yet'
  },
  RetentionSettings: { step: '5.4', reason: 'Read and changed from the data retention settings' },
  ScheduledReport: { step: '5.2', reason: 'Managed from the analytics reports' },
  StoreWarehouse: {
    step: '4.2',
    reason: 'Replaced through the warehouses endpoints (PR B), which have no route yet'
  },
  Warehouse: {
    step: '4.2',
    reason: 'Created and edited through the warehouses endpoints (PR B), which have no route yet'
  },
  Webhook: { step: '5.4', reason: 'Managed from Settings' }
}
