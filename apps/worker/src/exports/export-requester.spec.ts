import { auditActorOfRequester, auditViaOfRequester, isPluginRequester } from './export-requester'

const USER = '6f1c2b7e-3c1a-4d57-9a38-0d5f7a6b1c11'
const INSTALLATION = '0b8e7a52-6d1f-4a63-8c4e-2f9d3b7a1e55'

describe('the requester of an export', () => {
  it('is a person, who is the actor of the audit entry', () => {
    expect(isPluginRequester(USER)).toBe(false)
    expect(auditActorOfRequester(USER)).toEqual({ userId: USER })
    expect(auditViaOfRequester(USER)).toEqual({})
  })

  it('is a plugin, which is the system with its installation in the metadata (no row of users)', () => {
    const requester = `plugin:${INSTALLATION}`
    expect(isPluginRequester(requester)).toBe(true)
    expect(auditActorOfRequester(requester)).toEqual({ system: true })
    expect(auditViaOfRequester(requester)).toEqual({ pluginInstallationId: INSTALLATION })
  })
})
