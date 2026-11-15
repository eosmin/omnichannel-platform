import { ActorKinds } from '@platform/core/domain'
import type { AuthenticatedRequest } from '@platform/core/logger'

import { actorOf, auditActorOf, auditViaOf, identityOf, pluginActorOf, pluginUserId } from './actor'

describe('actorOf', () => {
  const user = { id: 'u-1', sessionFamilyId: 'f-1', email: 'a@example.com' }

  it('names who acted, in which store, and from where', () => {
    const request = {
      ip: '203.0.113.9',
      get: (name: string) => (name === 'user-agent' ? 'jest' : undefined)
    } as unknown as AuthenticatedRequest

    expect(actorOf(user, { id: 's-1' }, request)).toEqual({
      userId: 'u-1',
      storeId: 's-1',
      ipAddress: '203.0.113.9',
      userAgent: 'jest'
    })
  })

  it('leaves out what the request does not say', () => {
    const request = { get: () => undefined } as unknown as AuthenticatedRequest

    expect(actorOf(user, { id: 's-1' }, request)).toEqual({
      userId: 'u-1',
      storeId: 's-1',
      ipAddress: undefined,
      userAgent: undefined
    })
  })
})

describe('the actor of a plugin', () => {
  const request = {
    ip: '203.0.113.9',
    get: (name: string) => (name === 'user-agent' ? 'plugin-client' : undefined)
  } as unknown as AuthenticatedRequest

  it('is never the id of a person: it carries the installation', () => {
    expect(pluginUserId('inst-1')).toBe('plugin:inst-1')
    expect(pluginActorOf({ id: 'inst-1', pluginId: 'plug-1' }, { id: 's-1' }, request)).toEqual({
      userId: 'plugin:inst-1',
      storeId: 's-1',
      ipAddress: '203.0.113.9',
      userAgent: 'plugin-client',
      pluginInstallationId: 'inst-1',
      pluginId: 'plug-1'
    })
  })

  it('is recorded in the columns of authorship by the id of the plugin, never as a user', () => {
    expect(
      identityOf(pluginActorOf({ id: 'inst-1', pluginId: 'plug-1' }, { id: 's-1' }, request))
    ).toEqual({
      kind: ActorKinds.PLUGIN,
      pluginId: 'plug-1'
    })
    expect(identityOf({ userId: 'u-1', storeId: 's-1' })).toEqual({
      kind: ActorKinds.PERSON,
      userId: 'u-1'
    })
  })

  it('refuses a plugin actor that does not say which plugin it is', () => {
    expect(() =>
      identityOf({ userId: 'plugin:inst-1', storeId: 's-1', pluginInstallationId: 'inst-1' })
    ).toThrow(/id of its plugin/)
  })

  it('is written to the audit log as the system, with the installation in the metadata', () => {
    const plugin = pluginActorOf({ id: 'inst-1', pluginId: 'plug-1' }, { id: 's-1' }, request)

    expect(auditActorOf(plugin)).toEqual({ system: true })
    expect(auditViaOf(plugin)).toEqual({ pluginInstallationId: 'inst-1' })
  })

  it('leaves a person as the person who acted, with nothing added to the metadata', () => {
    const person = actorOf(
      { id: 'u-1', sessionFamilyId: 'f-1', email: 'a@example.com' },
      { id: 's-1' },
      request
    )

    expect(auditActorOf(person)).toEqual({ userId: 'u-1' })
    expect(auditViaOf(person)).toEqual({})
  })
})
