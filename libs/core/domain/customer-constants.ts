// The region that reads a phone number typed without a country code. The v1.2 MVP serves one owner
// in El Salvador: a region per store arrives with the SaaS phase (MVP_TRIM_CHECKLIST.md section 10).
export const DEFAULT_PHONE_REGION = 'SV'

// Which of the two customers of a merge a field is kept from (TDD_09 §6.1, "resolve field conflicts")
export const MergeFieldSources = {
  SURVIVOR: 'survivor',
  ABSORBED: 'absorbed'
} as const

export const MergeableFields = ['name', 'email', 'phone'] as const

export const CustomerLimits = {
  NAME_MAX_LENGTH: 120,
  // 254 is the longest address SMTP allows (RFC 5321)
  EMAIL_MAX_LENGTH: 254,
  LOCALE_MAX_LENGTH: 10,
  SEARCH_MAX_LENGTH: 100,
  CHANNEL_IDENTITY_MAX_LENGTH: 255,
  NOTE_MAX_LENGTH: 5000,
  ADDRESS_LABEL_MAX_LENGTH: 60,
  ADDRESS_FIELD_MAX_LENGTH: 200,
  ADDRESS_POSTAL_CODE_MAX_LENGTH: 20
} as const

// A language tag (es, es-SV): letters, and subtags of letters and digits
export const LOCALE_TAG_PATTERN = /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/
