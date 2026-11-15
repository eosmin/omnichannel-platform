import { RoleNames } from './auth/permissions'
import { ModerateRiskModes } from './safety-constants'
import {
  readSafetySettings,
  safetySettingsSchema,
  updateSafetySettingsSchema
} from './safety-settings'

describe('safetySettingsSchema', () => {
  it('asks for everything when nothing was chosen, for the roles that work the inbox', () => {
    expect(readSafetySettings({})).toEqual({
      confirmDeleteCustomer: true,
      confirmDisconnectChannel: true,
      confirmRemoveMember: true,
      applyToRoles: [RoleNames.AGENT, RoleNames.SUPERVISOR],
      moderateRiskMode: ModerateRiskModes.DIALOG
    })
  })

  it('reads what the store chose', () => {
    const chosen = {
      confirmDeleteCustomer: false,
      confirmDisconnectChannel: true,
      confirmRemoveMember: false,
      applyToRoles: [RoleNames.ADMIN],
      moderateRiskMode: ModerateRiskModes.NONE
    }

    expect(readSafetySettings(chosen)).toEqual(chosen)
  })

  it('reads a damaged key as its default, which is to ask, and keeps the good ones', () => {
    expect(
      readSafetySettings({
        confirmDeleteCustomer: false,
        confirmRemoveMember: 'no',
        applyToRoles: ['Owner'],
        moderateRiskMode: 3
      })
    ).toEqual({
      confirmDeleteCustomer: false,
      confirmDisconnectChannel: true,
      confirmRemoveMember: true,
      applyToRoles: [RoleNames.AGENT, RoleNames.SUPERVISOR],
      moderateRiskMode: ModerateRiskModes.DIALOG
    })
  })

  it('drops one role it does not know and keeps the others, and reads a value that is not a list as the default', () => {
    expect(
      readSafetySettings({ applyToRoles: ['Agent', 'Auditor', 'Admin', 'Agent'] }).applyToRoles
    ).toEqual([RoleNames.AGENT, RoleNames.ADMIN])
    // Nobody we know: the default. Empty on purpose: nobody
    expect(readSafetySettings({ applyToRoles: ['Auditor'] }).applyToRoles).toEqual([
      RoleNames.AGENT,
      RoleNames.SUPERVISOR
    ])
    expect(readSafetySettings({ applyToRoles: [] }).applyToRoles).toEqual([])
    expect(readSafetySettings({ applyToRoles: 'Agent' }).applyToRoles).toEqual([
      RoleNames.AGENT,
      RoleNames.SUPERVISOR
    ])
  })

  it('reads anything that is not an object as the defaults', () => {
    for (const raw of [null, undefined, 'x', 4, []]) {
      expect(readSafetySettings(raw)).toEqual(safetySettingsSchema.parse({}))
    }
  })

  it('does not share the default list of roles between reads', () => {
    const first = readSafetySettings({})
    first.applyToRoles.push(RoleNames.ADMIN)

    expect(readSafetySettings({}).applyToRoles).toEqual([RoleNames.AGENT, RoleNames.SUPERVISOR])
  })
})

describe('updateSafetySettingsSchema', () => {
  it('takes some keys and leaves the others out', () => {
    expect(updateSafetySettingsSchema.parse({ confirmRemoveMember: false })).toEqual({
      confirmRemoveMember: false
    })
  })

  it('refuses what is not a setting, a bad value and an empty body', () => {
    for (const body of [
      { other: true },
      { confirmDeleteCustomer: 'yes' },
      { applyToRoles: ['Viewer'] },
      { applyToRoles: [RoleNames.ADMIN, RoleNames.ADMIN] },
      { moderateRiskMode: 'later' },
      {}
    ]) {
      expect(updateSafetySettingsSchema.safeParse(body).success).toBe(false)
    }
  })
})

describe('SafetySwitchedActions', () => {
  it('names a key of the stored settings for each action, and a HIGH action only', async () => {
    const { DestructiveActionTierLevels, DestructiveActionTiers, SafetySwitchedActions } =
      await import('./safety-constants')
    const keys = Object.keys(safetySettingsSchema.parse({}))
    for (const [action, key] of Object.entries(SafetySwitchedActions)) {
      expect(keys).toContain(key)
      expect(DestructiveActionTiers[action as keyof typeof DestructiveActionTiers]).toBe(
        DestructiveActionTierLevels.HIGH
      )
    }
  })
})
