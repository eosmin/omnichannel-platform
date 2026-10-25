import type { Request, Response } from 'express'

import { bullBoardAccess } from './bull-board-access.middleware'

const USER_ID = '0b5f3f0e-6c36-4a4f-9d16-5b1d1c2f7a10'
const claims = (email: string): unknown => ({ sub: USER_ID, sid: USER_ID, email })

interface Outcome {
  status?: number
  body?: { error: { code: string } }
  nexted: boolean
}

async function run(
  authorization: string | undefined,
  verify: (token: string) => Promise<unknown>,
  adminEmails: readonly string[] = ['admin@example.com']
): Promise<Outcome> {
  const outcome: Outcome = { nexted: false }
  const req = { get: () => authorization, correlationId: 'c1' } as unknown as Request
  const res = {
    status(code: number) {
      outcome.status = code
      return this
    },
    json(body: Outcome['body']) {
      outcome.body = body
    }
  } as unknown as Response
  const settled = new Promise<void>(resolve => {
    const next = (): void => {
      outcome.nexted = true
      resolve()
    }
    const original = res.json.bind(res)
    res.json = ((body: Outcome['body']) => {
      original(body)
      resolve()
      return res
    }) as Response['json']
    bullBoardAccess({ verify, adminEmails })(req, res, next)
  })
  await settled
  return outcome
}

describe('bullBoardAccess', () => {
  it('lets in a verified token whose email is on the list, whatever its case', async () => {
    const outcome = await run('Bearer t', () => Promise.resolve(claims('Admin@Example.com')))

    expect(outcome.nexted).toBe(true)
    expect(outcome.status).toBeUndefined()
  })

  it('takes the scheme in any case, as the standard says', async () => {
    const outcome = await run('bearer t', () => Promise.resolve(claims('admin@example.com')))

    expect(outcome.nexted).toBe(true)
  })

  it('names the cause of a refusal for an address that is not on the list', async () => {
    const outcome = await run('Bearer t', () => Promise.resolve(claims('someone@example.com')))

    expect(outcome.status).toBe(403)
    expect(outcome.body?.error.code).toBe('PERMISSION_DENIED')
  })

  it('never calls verify without a well-formed Bearer header', async () => {
    const verify = jest.fn(() => Promise.resolve(claims('admin@example.com')))

    for (const header of [undefined, '', 'Bearer', 'Bearer ', 'Bearer a b', 'Token abc']) {
      const outcome = await run(header, verify)
      expect(outcome.status).toBe(401)
      expect(outcome.body?.error.code).toBe('AUTH_UNAUTHORIZED')
    }
    expect(verify).not.toHaveBeenCalled()
  })

  it('refuses everybody when the list is empty, a valid admin token included', async () => {
    const outcome = await run('Bearer t', () => Promise.resolve(claims('admin@example.com')), [])

    expect(outcome.status).toBe(403)
    expect(outcome.nexted).toBe(false)
  })

  it('does not match an address by prefix or by suffix', async () => {
    for (const email of ['admin@example.com.evil.io', 'xadmin@example.com', 'admin@example.co']) {
      const outcome = await run('Bearer t', () => Promise.resolve(claims(email)))
      expect(outcome.status).toBe(403)
    }
  })

  it('tells an expired token from one that does not verify', async () => {
    const expired = Object.assign(new Error('jwt expired'), { name: 'TokenExpiredError' })

    const late = await run('Bearer t', () => Promise.reject(expired))
    const bad = await run('Bearer t', () => Promise.reject(new Error('invalid signature')))
    // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- a library may reject with anything
    const odd = await run('Bearer t', () => Promise.reject('not even an Error'))

    expect(late.body?.error.code).toBe('AUTH_TOKEN_EXPIRED')
    expect(bad.body?.error.code).toBe('AUTH_TOKEN_INVALID')
    expect(odd.body?.error.code).toBe('AUTH_TOKEN_INVALID')
    expect([late.status, bad.status, odd.status]).toEqual([401, 401, 401])
  })

  it('answers with the contract and the correlation id', () => {
    let seen: unknown
    const req = { get: () => undefined, correlationId: 'corr-9' } as unknown as Request
    const res = {
      status: () => res,
      json: (body: unknown) => {
        seen = body
      }
    } as unknown as Response

    bullBoardAccess({ verify: () => Promise.resolve({}), adminEmails: [] })(req, res, jest.fn())

    expect(seen).toMatchObject({ error: { metadata: {} }, correlationId: 'corr-9' })
  })
})
