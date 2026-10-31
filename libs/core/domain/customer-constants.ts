// The region that reads a phone number typed without a country code. The v1.2 MVP serves one owner
// in El Salvador: a region per store arrives with the SaaS phase (MVP_TRIM_CHECKLIST.md section 10).
export const DEFAULT_PHONE_REGION = 'SV'

// Which of the two customers of a merge a field is kept from (TDD_09 §6.1, "resolve field conflicts")
export const MergeFieldSources = {
  SURVIVOR: 'survivor',
  ABSORBED: 'absorbed'
} as const

// What the activity timeline of a customer is made of (TDD_09 §6). Orders join it in Step 4.3.
export const CustomerTimelineTypes = {
  CONVERSATION: 'conversation',
  NOTE: 'note',
  MERGE: 'merge'
} as const

export type CustomerTimelineType =
  (typeof CustomerTimelineTypes)[keyof typeof CustomerTimelineTypes]

export const MergeableFields = ['name', 'email', 'phone'] as const

export const CustomerLimits = {
  NAME_MAX_LENGTH: 120,
  // 254 is the longest address SMTP allows (RFC 5321)
  EMAIL_MAX_LENGTH: 254,
  LOCALE_MAX_LENGTH: 10,
  SEARCH_MAX_LENGTH: 100,
  CHANNEL_IDENTITY_MAX_LENGTH: 255,
  NOTE_MAX_LENGTH: 5000,
  USERNAME_MAX_LENGTH: 100,
  AVATAR_URL_MAX_LENGTH: 2048,
  ADDRESS_LABEL_MAX_LENGTH: 60,
  ADDRESS_FIELD_MAX_LENGTH: 200,
  ADDRESS_POSTAL_CODE_MAX_LENGTH: 20
} as const

// The name and photo a channel keeps for a customer (Step 2.8, PR 1c-2). The photo link is signed and
// expires, so the profile is read again after this many days.
export const CustomerProfileFetch = {
  STALE_AFTER_DAYS: 7,
  // A read gets less room than a send, and its queue runs few at a time: Meta's limits count per app
  TIMEOUT_MS: 10_000,
  CONCURRENCY: 5,
  ATTEMPTS: 3,
  // Meta throttles for minutes: tries a few seconds apart only prolong a throttle
  BACKOFF_MS: 60_000,
  JOB_ID_PREFIX: 'profile',
  // A read that failed for lack of an answer (an outage) is asked again after this, not after a week
  RETRY_AFTER_HOURS: 1
} as const

// Why a read of a profile failed: a refusal is final until the profile is stale, an outage got no answer
export const ProfileFailureKinds = { REFUSED: 'refused', OUTAGE: 'outage' } as const
export type ProfileFailureKind = (typeof ProfileFailureKinds)[keyof typeof ProfileFailureKinds]

// A language tag (es, es-SV): letters, and subtags of letters and digits
export const LOCALE_TAG_PATTERN = /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/
