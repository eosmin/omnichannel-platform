// What a person may change about their own account (Step 3.6). The words are the ones the settings
// pages draw; the column is a string, so the set is closed here and checked at the boundary.
export const UiDensity = {
  COMFORTABLE: 'comfortable',
  COMPACT: 'compact'
} as const
export type UiDensityType = (typeof UiDensity)[keyof typeof UiDensity]
export const DEFAULT_UI_DENSITY: UiDensityType = UiDensity.COMFORTABLE

export const AccountLimits = {
  NAME_MAX_LENGTH: 100
} as const

// The name of an organization or of a store: the api refuses a longer one and the forms check it
// before sending
export const OrganizationLimits = {
  NAME_MAX_LENGTH: 100
} as const
