import { DatabaseRoles } from '../testing/connection-urls'

import { replicaRoleProblem, type ReplicaRoleFacts } from './replica-role'

const READ_ONLY_ROLE: ReplicaRoleFacts = {
  roleName: DatabaseRoles.REPLICA,
  isSuperuser: false,
  bypassesRls: false,
  canWrite: false,
  inRecovery: false
}

describe('replicaRoleProblem', () => {
  it('accepts the read only role on a server that is not a standby', () => {
    expect(replicaRoleProblem(READ_ONLY_ROLE)).toBeNull()
  })

  it('accepts a role that can write on a real standby, which refuses every write', () => {
    expect(
      replicaRoleProblem({
        ...READ_ONLY_ROLE,
        roleName: DatabaseRoles.APP,
        canWrite: true,
        inRecovery: true
      })
    ).toBeNull()
  })

  it('refuses a role that can write on a server that is not a standby, naming the role', () => {
    const problem = replicaRoleProblem({
      ...READ_ONLY_ROLE,
      roleName: DatabaseRoles.APP,
      canWrite: true
    })
    expect(problem).toContain(DatabaseRoles.APP)
    expect(problem).toContain(DatabaseRoles.REPLICA)
  })

  it.each([
    ['a superuser', { isSuperuser: true }],
    ['a role that skips row level security', { bypassesRls: true }]
  ])('refuses %s even on a standby', (_label, change) => {
    expect(replicaRoleProblem({ ...READ_ONLY_ROLE, inRecovery: true, ...change })).not.toBeNull()
  })
})
