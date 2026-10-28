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
  ConversationOrigin: {
    step: '3.2',
    reason:
      'Written by the inbound pipeline and read by the origin card of the thread. Until then ' +
      'tests/api/inbound.spec.ts proves the write (the row lands in the store of the connection). ' +
      'The case with the other store reading it through the api is added by Step 3.2'
  },
  ConsentRecord: { step: '7.2', reason: 'Written by the compliance flows' },
  DataSubjectRequest: { step: '7.2', reason: 'Created by the data subject request flow' },
  Export: { step: '3.4', reason: 'Created by the first export (the media gallery)' },
  InventoryMovement: { step: '4.2', reason: 'Written by the stock operations' },
  Media: { step: '3.4', reason: 'Has no endpoint yet' },
  MessageReaction: {
    step: '2.8',
    reason:
      'Written by the inbound pipeline and read inside the messages of a thread. Until then ' +
      'tests/api/inbound-echo-reactions.spec.ts proves the write (the reaction lands in the store of ' +
      'the connection, never in another store with the same provider id) and the read. The case with ' +
      'the other store reaching it through the api is added with the endpoint that lets an agent react'
  },
  MetricDaily: { step: '5.2', reason: 'Read only through the analytics queries' },
  MetricHourly: { step: '5.2', reason: 'Read only through the analytics queries' },
  Notification: { step: '3.5', reason: 'Has no endpoint yet' },
  NotificationPreference: { step: '3.5', reason: 'Has no endpoint yet' },
  Order: { step: '4.3', reason: 'Has no endpoint yet' },
  Product: { step: '4.1', reason: 'Has no endpoint yet' },
  RetentionSettings: { step: '5.4', reason: 'Read and changed from the data retention settings' },
  ScheduledReport: { step: '5.2', reason: 'Managed from the analytics reports' },
  Webhook: { step: '5.4', reason: 'Managed from Settings' }
}
