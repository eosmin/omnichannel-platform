import { signRemoteCommand, verifyRemoteCommand } from './remote-command-signature'

const BODY = '{"command":"message.send","storeId":"s","connectionId":"c","data":{}}'
const NOW = 1_800_000_000

describe('signRemoteCommand', () => {
  it('signs "<t>.<raw body>" with HMAC-SHA256 and writes t and one v1 per secret', () => {
    const header = signRemoteCommand(BODY, ['secret-one'], NOW)
    expect(header).toMatch(/^t=1800000000,v1=[0-9a-f]{64}$/)
    const two = signRemoteCommand(BODY, ['secret-one', 'secret-two'], NOW)
    expect(two.split(',')).toHaveLength(3)
    expect(two.startsWith(header)).toBe(true)
  })

  it('refuses to sign with no secret', () => {
    expect(() => signRemoteCommand(BODY, [], NOW)).toThrow('no command secret')
  })

  it('changes with the body, the time and the secret', () => {
    const base = signRemoteCommand(BODY, ['a'], NOW)
    expect(signRemoteCommand(`${BODY} `, ['a'], NOW)).not.toBe(base)
    expect(signRemoteCommand(BODY, ['a'], NOW + 1)).not.toBe(base)
    expect(signRemoteCommand(BODY, ['b'], NOW)).not.toBe(base)
  })
})

describe('verifyRemoteCommand (what a plugin does with a command)', () => {
  it('accepts a signature that matches any of the secrets it knows', () => {
    const header = signRemoteCommand(BODY, ['new', 'old'], NOW)
    expect(verifyRemoteCommand(header, BODY, ['old'], NOW)).toBe(true)
    expect(verifyRemoteCommand(header, BODY, ['new'], NOW)).toBe(true)
    expect(verifyRemoteCommand(header, BODY, ['other', 'new'], NOW)).toBe(true)
  })

  it('refuses a secret it does not know, a changed body and a malformed header', () => {
    const header = signRemoteCommand(BODY, ['new'], NOW)
    expect(verifyRemoteCommand(header, BODY, ['other'], NOW)).toBe(false)
    expect(verifyRemoteCommand(header, `${BODY}x`, ['new'], NOW)).toBe(false)
    expect(verifyRemoteCommand('', BODY, ['new'], NOW)).toBe(false)
    expect(verifyRemoteCommand('v1=abcd', BODY, ['new'], NOW)).toBe(false)
    expect(verifyRemoteCommand(`t=abc,v1=${'0'.repeat(64)}`, BODY, ['new'], NOW)).toBe(false)
    expect(verifyRemoteCommand(`t=${NOW},v1=zz`, BODY, ['new'], NOW)).toBe(false)
  })

  it('refuses a time more than 5 minutes from its clock, in either direction (the replay window)', () => {
    const header = signRemoteCommand(BODY, ['s'], NOW)
    expect(verifyRemoteCommand(header, BODY, ['s'], NOW + 300)).toBe(true)
    expect(verifyRemoteCommand(header, BODY, ['s'], NOW + 301)).toBe(false)
    expect(verifyRemoteCommand(header, BODY, ['s'], NOW - 300)).toBe(true)
    expect(verifyRemoteCommand(header, BODY, ['s'], NOW - 301)).toBe(false)
  })

  it('does not take a signature whose time was edited', () => {
    const header = signRemoteCommand(BODY, ['s'], NOW)
    const moved = header.replace(`t=${NOW}`, `t=${NOW + 10}`)
    expect(verifyRemoteCommand(moved, BODY, ['s'], NOW + 10)).toBe(false)
  })
})
