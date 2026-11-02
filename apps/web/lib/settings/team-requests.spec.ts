import { ApiError, createApiClient } from '@platform/api-client'
import { TenantHeaders } from '@platform/core/auth'

import {
  changeMemberRole,
  createRole,
  deleteRole,
  fetchInvitations,
  fetchMembers,
  fetchRoles,
  inviteMember,
  removeMember,
  resendInvitation,
  revokeInvitation,
  updateRole
} from './team-requests'

function setup(body: unknown, status = 200) {
  const fetchImpl = jest.fn<Promise<Response>, [string, RequestInit]>().mockImplementation(() =>
    Promise.resolve(
      status === 204
        ? new Response(null, { status })
        : new Response(JSON.stringify(body), {
            status,
            headers: { 'content-type': 'application/json' }
          })
    )
  )
  const client = createApiClient({
    baseUrl: 'https://api.example.com',
    getAccessToken: () => 'token',
    refreshAccessToken: () => Promise.resolve('token'),
    fetchImpl: fetchImpl as unknown as typeof fetch
  })
  const call = () => fetchImpl.mock.calls[0] ?? []
  return { client, call }
}

const role = { id: 'r1', name: 'Agent', description: null, isSystem: true, permissions: ['x:y'] }
const member = {
  id: 'm1',
  userId: 'u1',
  name: 'Ana',
  email: 'ana@example.com',
  role: { id: 'r1', name: 'Agent' },
  joinedAt: '2026-11-01T10:00:00.000Z'
}
const invitation = {
  id: 'i1',
  email: 'bo@example.com',
  role: { id: 'r1', name: 'Agent' },
  invitedBy: 'Ana',
  expiresAt: '2026-11-08T10:00:00.000Z',
  createdAt: '2026-11-01T10:00:00.000Z',
  expired: false
}

function bodyOf(init: RequestInit | undefined): unknown {
  return typeof init?.body === 'string' ? JSON.parse(init.body) : undefined
}

function header(init: RequestInit | undefined, name: string): string | null {
  return new Headers(init?.headers).get(name)
}

describe('team requests', () => {
  it('reads the members of the store named in X-Store-Id', async () => {
    const { client, call } = setup([member])
    await expect(fetchMembers(client, 's1')).resolves.toEqual([member])
    expect(call()[0]).toBe('https://api.example.com/api/v1/settings/team/members')
    expect(header(call()[1], TenantHeaders.STORE_ID)).toBe('s1')
  })

  it('changes a role by sending only the role id', async () => {
    const { client, call } = setup(member)
    await changeMemberRole(client, 's1', 'm/1', 'r2')
    expect(call()[0]).toBe('https://api.example.com/api/v1/settings/team/members/m%2F1')
    expect(call()[1]?.method).toBe('PATCH')
    expect(bodyOf(call()[1])).toEqual({ roleId: 'r2' })
  })

  it('removes a member and takes a 204 for success', async () => {
    const { client, call } = setup(null, 204)
    await expect(removeMember(client, 's1', 'm1')).resolves.toBeUndefined()
    expect(call()[1]?.method).toBe('DELETE')
  })

  it('creates, updates and deletes a role', async () => {
    const created = setup(role)
    await createRole(created.client, 's1', { name: 'N', permissions: ['x:y'] })
    expect(created.call()[0]).toBe('https://api.example.com/api/v1/settings/roles')
    expect(created.call()[1]?.method).toBe('POST')

    const updated = setup(role)
    await updateRole(updated.client, 's1', 'r1', { description: null })
    expect(updated.call()[0]).toBe('https://api.example.com/api/v1/settings/roles/r1')
    expect(bodyOf(updated.call()[1])).toEqual({ description: null })

    const deleted = setup(null, 204)
    await expect(deleteRole(deleted.client, 's1', 'r1')).resolves.toBeUndefined()
  })

  it('reads roles and refuses an answer of another shape', async () => {
    const ok = setup([role])
    await expect(fetchRoles(ok.client, 's1')).resolves.toEqual([role])
    const bad = setup([{ id: 'r1' }])
    await expect(fetchRoles(bad.client, 's1')).rejects.toBeDefined()
  })

  it('invites, resends and revokes through their own routes', async () => {
    const invited = setup(invitation, 201)
    await inviteMember(invited.client, 's1', { email: 'bo@example.com', roleId: 'r1' })
    expect(invited.call()[0]).toBe('https://api.example.com/api/v1/settings/team/members')
    expect(invited.call()[1]?.method).toBe('POST')

    const resent = setup(invitation)
    await resendInvitation(resent.client, 's1', 'i1')
    expect(resent.call()[0]).toBe(
      'https://api.example.com/api/v1/settings/team/invitations/i1/resend'
    )
    expect(resent.call()[1]?.method).toBe('POST')

    const revoked = setup(null, 204)
    await revokeInvitation(revoked.client, 's1', 'i1')
    expect(revoked.call()[0]).toBe('https://api.example.com/api/v1/settings/team/invitations/i1')
    expect(revoked.call()[1]?.method).toBe('DELETE')

    const listed = setup([invitation])
    await expect(fetchInvitations(listed.client, 's1')).resolves.toEqual([invitation])
  })

  it('surfaces the code of a refusal, such as the cooldown of a resend', async () => {
    const { client } = setup(
      {
        error: { code: 'RATE_LIMIT_EXCEEDED', message: 'x', metadata: { retryAfterSeconds: 60 } },
        correlationId: 'c'
      },
      429
    )
    const error: unknown = await resendInvitation(client, 's1', 'i1').catch((e: unknown) => e)
    expect(error).toBeInstanceOf(ApiError)
    expect((error as ApiError).code).toBe('RATE_LIMIT_EXCEEDED')
    expect((error as ApiError).metadata).toEqual({ retryAfterSeconds: 60 })
  })
})
