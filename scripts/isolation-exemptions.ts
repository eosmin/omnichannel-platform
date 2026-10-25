import type { IsolationExemption } from './lib/isolation'

// The models with a store_id that have no case in the tenant isolation suite yet, because the
// platform has no endpoint for them yet. Each one names the step of the plan that builds it:
// check-isolation-coverage fails as soon as that step is `done` in the progress table of
// docs/IMPLEMENTATION_PLAN.md and the model is still here, so the case is added when the resource
// is built and not "later". The step that builds a resource deletes its line and adds its case to
// tests/security/tenant-isolation.spec.ts (CLAUDE.md, rule 3).
//
// `Tag` is not here: it is covered through the test-only probe controller until its real endpoint
// (Step 2.3) replaces it.
export const ISOLATION_EXEMPTIONS: Readonly<Record<string, IsolationExemption>> = {
  AnalyticsEvent: {
    step: '5.2',
    reason: 'Written by the pipelines and read only through the analytics queries'
  },
  ApiKey: { step: '5.4', reason: 'Created and revoked from Settings' },
  AuditLog: { step: '1.4', reason: 'Read through the audit log viewer of the organization' },
  BusinessHours: { step: '2.3', reason: 'Read and changed from the settings of the store' },
  ChannelConnection: {
    step: '2.6',
    reason: 'Resolved by the inbound pipeline and managed from Settings'
  },
  ConsentRecord: { step: '7.2', reason: 'Written by the compliance flows' },
  Conversation: { step: '2.3', reason: 'Has no endpoint yet' },
  Customer: { step: '2.2', reason: 'Has no endpoint yet' },
  CustomerIdentity: { step: '2.2', reason: 'Reached through its customer' },
  CustomerMerge: { step: '2.2', reason: 'Reached through the customer merge' },
  DataSubjectRequest: { step: '7.2', reason: 'Created by the data subject request flow' },
  Export: { step: '3.4', reason: 'Created by the first export (the media gallery)' },
  InventoryMovement: { step: '4.2', reason: 'Written by the stock operations' },
  Invitation: { step: '1.4', reason: 'Created and accepted through the team endpoints' },
  Media: { step: '3.4', reason: 'Has no endpoint yet' },
  Membership: { step: '1.4', reason: 'Managed through the team endpoints' },
  Message: { step: '2.3', reason: 'Has no endpoint yet' },
  MetricDaily: { step: '5.2', reason: 'Read only through the analytics queries' },
  MetricHourly: { step: '5.2', reason: 'Read only through the analytics queries' },
  Notification: { step: '3.5', reason: 'Has no endpoint yet' },
  NotificationPreference: { step: '3.5', reason: 'Has no endpoint yet' },
  Order: { step: '4.3', reason: 'Has no endpoint yet' },
  PluginInstallation: { step: '5.6', reason: 'Managed from Settings' },
  Product: { step: '4.1', reason: 'Has no endpoint yet' },
  RetentionSettings: { step: '5.4', reason: 'Read and changed from the data retention settings' },
  Role: { step: '1.4', reason: 'Managed through the team endpoints' },
  RoutingRule: { step: '2.3', reason: 'Managed from the settings of the store' },
  ScheduledReport: { step: '5.2', reason: 'Managed from the analytics reports' },
  Snippet: { step: '2.3', reason: 'Managed from the settings of the store' },
  StoreSettings: { step: '1.4', reason: 'Read and changed through the store endpoints' },
  Webhook: { step: '5.4', reason: 'Managed from Settings' }
}
