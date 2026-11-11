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
    step: '5.2',
    reason: 'Written by the pipelines and read only through the analytics queries'
  },
  ApiKey: { step: '5.4', reason: 'Created and revoked from Settings' },
  AuditLog: { step: '7.2', reason: 'Read through the audit log viewer of the organization' },
  BulkLabelJob: {
    step: '4.10',
    reason: 'Created by POST /shipments/bulk and read through its progress'
  },
  CarrierConnection: { step: '4.8', reason: 'Managed from Settings → Carriers (PR B2)' },
  CarrierService: { step: '4.8', reason: 'Seeded with a connection and read through it (PR B2)' },
  CarrierStatusMapping: {
    step: '4.8',
    reason: 'Seeded with a connection, edited through the status mapping routes (PR C2)'
  },
  CarrierUnmappedStatus: {
    step: '4.8',
    reason: 'Written by the carrier event processor, listed in Settings → Carriers (PR C2)'
  },
  ConsentRecord: { step: '7.2', reason: 'Written by the compliance flows' },
  DataSubjectRequest: { step: '7.2', reason: 'Created by the data subject request flow' },
  GuideSequence: {
    step: '4.8',
    reason: 'Created with a local connection and advanced by guide creation (PR B2)'
  },
  MetricDaily: { step: '5.2', reason: 'Read only through the analytics queries' },
  MetricHourly: { step: '5.2', reason: 'Read only through the analytics queries' },
  OrderMessageTemplate: { step: '4.9', reason: 'Managed from Settings → Order messages' },
  OrderReturn: { step: '4.12', reason: 'Created and read through the returns routes' },
  OrderReturnLine: { step: '4.12', reason: 'Read and written through its return' },
  PickupRequest: { step: '4.11', reason: 'Created and read through the pickups routes' },
  RetentionSettings: { step: '5.4', reason: 'Read and changed from the data retention settings' },
  ScheduledReport: { step: '5.2', reason: 'Managed from the analytics reports' },
  Shipment: { step: '4.8', reason: 'Created and read through the shipments routes (PR C1)' },
  ShipmentEvent: { step: '4.8', reason: 'Read through its shipment (PR C1)' },
  Webhook: { step: '5.4', reason: 'Managed from Settings' }
}
