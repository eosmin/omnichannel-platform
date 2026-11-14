import { z } from 'zod'

import { RoleNames } from './auth/permissions'

// How a store asks before a destructive action of the HIGH and MODERATE tiers (TDD_09 §11.2). CRITICAL
// actions always ask for a typed phrase and LOW ones always offer an undo toast: neither is a setting.
export const ModerateRiskModes = {
  DIALOG: 'dialog',
  UNDO: 'undo',
  NONE: 'none'
} as const
export type ModerateRiskMode = (typeof ModerateRiskModes)[keyof typeof ModerateRiskModes]

// The system roles a confirmation can be limited to. A custom role is never listed and so always asks: the
// switch can only take the dialog away from the roles of the preset.
export const SafetyRoleNames = [RoleNames.AGENT, RoleNames.SUPERVISOR, RoleNames.ADMIN] as const

const roleList = z
  .array(z.enum(SafetyRoleNames))
  .max(SafetyRoleNames.length)
  .refine(roles => new Set(roles).size === roles.length, { message: 'duplicate role' })

// The factory list is the one of TDD_09 §11.2: Agent and Supervisor ask, Admin does not (the people who run the store
// are not slowed down by the dialogs made for the ones who work its inbox); a store turns Admin on in the page
const defaultApplyToRoles: readonly (typeof SafetyRoleNames)[number][] = [
  RoleNames.AGENT,
  RoleNames.SUPERVISOR
]

// The column `StoreSettings.safety`. A key that is missing or damaged reads as its default, which asks (the three
// switches are on, the moderate actions get a dialog), so a store that never opened the page keeps its confirmations
export const safetySettingsSchema = z.object({
  confirmDeleteCustomer: z.boolean().catch(true),
  confirmDisconnectChannel: z.boolean().catch(true),
  confirmRemoveMember: z.boolean().catch(true),
  // The roles that are asked for the three confirmations above (a role not listed acts without the dialog)
  applyToRoles: roleList.catch(() => [...defaultApplyToRoles]),
  moderateRiskMode: z.enum(ModerateRiskModes).catch(ModerateRiskModes.DIALOG)
})

export type SafetySettings = z.output<typeof safetySettingsSchema>

// The column is written by the api, but a value that does not fit reads as the defaults
export function readSafetySettings(raw: unknown): SafetySettings {
  const parsed = safetySettingsSchema.safeParse(raw)
  return parsed.success ? parsed.data : safetySettingsSchema.parse({})
}

// What PUT /settings/safety takes: the keys the caller changes, each held to its real type. Keys that are
// not named keep their value.
export const updateSafetySettingsSchema = z
  .strictObject({
    confirmDeleteCustomer: z.boolean().optional(),
    confirmDisconnectChannel: z.boolean().optional(),
    confirmRemoveMember: z.boolean().optional(),
    applyToRoles: roleList.optional(),
    moderateRiskMode: z.enum(ModerateRiskModes).optional()
  })
  .refine(body => Object.values(body).some(value => value !== undefined), {
    message: 'nothing to change'
  })

export type UpdateSafetySettingsBody = z.output<typeof updateSafetySettingsSchema>
