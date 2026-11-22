import { type Actor, auditActorOf, auditViaOf } from './actor'

const person: Actor = { userId: 'user-1', storeId: 'store-1' }

describe('the actor of an audit entry', () => {
  it('records a person by id and adds nothing to the metadata', () => {
    expect(auditActorOf(person)).toEqual({ userId: 'user-1' })
    expect(auditViaOf(person)).toEqual({})
  })

  it('records a plugin as the system, with its installation in the metadata', () => {
    const plugin: Actor = { ...person, userId: 'plugin:inst-1', pluginInstallationId: 'inst-1' }

    expect(auditActorOf(plugin)).toEqual({ system: true })
    expect(auditViaOf(plugin)).toEqual({ pluginInstallationId: 'inst-1' })
  })

  it('records the sweep of a data request as the system, with the request in the metadata and its label in no user column', () => {
    const sweep: Actor = {
      userId: 'system:dsr-erase-due',
      storeId: 'store-1',
      system: true,
      dsrRequestId: 'req-1'
    }

    expect(auditActorOf(sweep)).toEqual({ system: true })
    expect(auditViaOf(sweep)).toEqual({ dsrRequestId: 'req-1' })
  })
})
