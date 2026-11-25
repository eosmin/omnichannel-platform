// What a store may choose for each window of RetentionSettings (days, both ends included). The floors keep a
// slip of the hand (a 1 for a 100) from erasing the history of a store in one night; the ceilings are the
// ten years of the tax records (Codigo Tributario art. 147). The same numbers are checked by the CHECK constraints of retention_settings.
export const RetentionBounds = {
  conversationDays: { min: 30, max: 3650 },
  mediaDays: { min: 30, max: 3650 },
  analyticsDays: { min: 90, max: 1095 },
  notificationDays: { min: 7, max: 365 }
} as const

export type RetentionField = keyof typeof RetentionBounds
