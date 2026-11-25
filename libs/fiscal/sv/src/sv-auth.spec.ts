import { FiscalEnvironment } from '@platform/core/domain'

import { SvAuthenticator } from './sv-auth'
import { SvAnswerStates, SvAuthentication } from './sv-constants'
import { type SvFetch } from './sv-http'

// The authority locks a user after more than 3 wrong logins (Manual Técnico §1.1): a password it refused is never sent again while the
// memory of the refusal lasts, however many documents ask for the token.

const NIT = '06141234567890'
const PASSWORD = 'not-a-real-password'
const answer = (status: number, body: unknown): ReturnType<SvFetch> =>
  Promise.resolve({ status, text: () => Promise.resolve(JSON.stringify(body)) })

const build = (respond: () => ReturnType<SvFetch>) => {
  let now = 1_000_000
  let calls = 0
  const auth = new SvAuthenticator({
    fetch: () => {
      calls += 1
      return respond()
    },
    now: () => now,
    userAgent: 'test',
    timeoutMs: 1000
  })
  return {
    auth,
    calls: () => calls,
    advance: (ms: number) => {
      now += ms
    }
  }
}

describe('SvAuthenticator against wrong credentials', () => {
  it('does not send a refused password again while the memory of the refusal lasts', async () => {
    const t = build(() => answer(401, { status: SvAnswerStates.ERROR }))
    for (let i = 0; i < 10; i += 1) {
      expect(await t.auth.login(FiscalEnvironment.SANDBOX, NIT, PASSWORD)).toEqual({
        kind: 'rejected'
      })
    }
    expect(t.calls()).toBe(1)
  })

  it('asks once more only after the memory ended, and that is one call, not a loop', async () => {
    const t = build(() => answer(401, { status: SvAnswerStates.ERROR }))
    await t.auth.login(FiscalEnvironment.SANDBOX, NIT, PASSWORD)
    t.advance(SvAuthentication.REJECTED_MEMORY_MS + 1)
    await t.auth.login(FiscalEnvironment.SANDBOX, NIT, PASSWORD)
    await t.auth.login(FiscalEnvironment.SANDBOX, NIT, PASSWORD)
    expect(t.calls()).toBe(2)
  })

  it('shares one login among the documents that wait for the same token', async () => {
    const t = build(() => answer(401, { status: SvAnswerStates.ERROR }))
    await Promise.all(
      Array.from({ length: 5 }, () => t.auth.login(FiscalEnvironment.SANDBOX, NIT, PASSWORD))
    )
    expect(t.calls()).toBe(1)
  })

  it('does not remember a fault of the moment as a wrong password', async () => {
    const t = build(() => answer(503, { status: SvAnswerStates.ERROR }))
    expect(await t.auth.login(FiscalEnvironment.SANDBOX, NIT, PASSWORD)).toEqual({
      kind: 'unavailable'
    })
    await t.auth.login(FiscalEnvironment.SANDBOX, NIT, PASSWORD)
    expect(t.calls()).toBe(2)
  })
})

// The probe of an open contingency asks whether the authority answers now: a token in memory proves nothing, and a refused password is never
// sent again by it either.
describe('SvAuthenticator probe', () => {
  const ok = () => answer(200, { status: SvAnswerStates.OK, body: { token: 'Bearer abc' } })

  it('reaches the authority even when a token is kept, and keeps the new one', async () => {
    const t = build(ok)
    await t.auth.login(FiscalEnvironment.SANDBOX, NIT, PASSWORD)
    expect(await t.auth.probe(FiscalEnvironment.SANDBOX, NIT, PASSWORD)).toEqual({
      kind: 'token',
      token: 'Bearer abc'
    })
    expect(t.calls()).toBe(2)
    // What the probe got serves the documents that come next
    await t.auth.login(FiscalEnvironment.SANDBOX, NIT, PASSWORD)
    expect(t.calls()).toBe(2)
  })

  it('says unavailable when the authority does not answer, and asks again the next time', async () => {
    const t = build(() => answer(503, { status: SvAnswerStates.ERROR }))
    expect(await t.auth.probe(FiscalEnvironment.SANDBOX, NIT, PASSWORD)).toEqual({
      kind: 'unavailable'
    })
    await t.auth.probe(FiscalEnvironment.SANDBOX, NIT, PASSWORD)
    expect(t.calls()).toBe(2)
  })

  it('does not send a password the authority refused, however often it is probed', async () => {
    const t = build(() => answer(401, { status: SvAnswerStates.ERROR }))
    for (let i = 0; i < 5; i += 1) {
      expect(await t.auth.probe(FiscalEnvironment.SANDBOX, NIT, PASSWORD)).toEqual({
        kind: 'rejected'
      })
    }
    expect(t.calls()).toBe(1)
  })

  it('shares one call among probes that run together', async () => {
    const t = build(ok)
    await Promise.all(
      Array.from({ length: 4 }, () => t.auth.probe(FiscalEnvironment.SANDBOX, NIT, PASSWORD))
    )
    expect(t.calls()).toBe(1)
  })
})
