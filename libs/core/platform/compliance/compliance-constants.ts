export const ComplianceConfig = {
  DSR_RESPONSE_DEADLINE_DAYS: 30,
  DSR_DEADLINE_ALERT_DAY: 25,
  DSR_EXTENSION_DAYS: 60,
  DSR_VERIFICATION_TOKEN_DAYS: 7,
  DSR_EXPORT_LINK_DAYS: 7,
  BREACH_NOTIFICATION_HOURS: 72,
  ERASURE_GRACE_PERIOD_DAYS: 30,
  UNMERGE_WINDOW_DAYS: 30,
  ERASED_CONTENT_PLACEHOLDER: '[erased]' // Written into Message.content on erasure
} as const

// Platform-wide floors and ceilings. Tenant-configurable values live in RetentionSettings, and
// the effective window is RetentionSettings only (the v1.2 MVP has no plans).
export const DataRetentionPolicies = {
  CONVERSATIONS: { defaultDays: 730, configurable: true }, // Messages follow conversations
  MEDIA: { defaultDays: 365, configurable: true },
  ORDERS: { defaultDays: 2555, configurable: false }, // Tax: 7 years
  AUDIT_LOGS_HOT: { defaultDays: 730, configurable: false }, // Then cold storage, TDD_05 §9.3
  AUDIT_LOGS_COLD: { defaultDays: 2555, configurable: false },
  ANALYTICS_EVENTS: { defaultDays: 395, configurable: true },
  SESSIONS: { defaultDays: 30, configurable: false },
  VERIFICATION_TOKENS: { defaultDays: 7, configurable: false },
  NOTIFICATIONS: { defaultDays: 90, configurable: true },
  WEBHOOK_DELIVERIES: { defaultDays: 30, configurable: false },
  EXPORTS: { defaultDays: 7, configurable: false },
  CUSTOMER_MERGES: { defaultDays: 30, configurable: false }
} as const

export const LegalBases = {
  CONSENT: 'consent',
  CONTRACT: 'contract',
  LEGAL_OBLIGATION: 'legal_obligation',
  LEGITIMATE_INTERESTS: 'legitimate_interests'
} as const

export const CookieCategories = {
  NECESSARY: 'necessary', // No consent required
  FUNCTIONAL: 'functional', // Language, last store
  ANALYTICS: 'analytics', // Product usage
  MARKETING: 'marketing' // Not used currently
} as const

// A new version re-prompts the cookie consent.
export const COOKIE_POLICY_VERSION = '2026-09-01'
