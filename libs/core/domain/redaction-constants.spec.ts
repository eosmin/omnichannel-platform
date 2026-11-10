import {
  declaredRedactedKeys,
  isSecretHeader,
  MAX_DECLARED_REDACTED_KEYS,
  REPORT_REDACTED_HEADERS,
  SENSITIVE_QUERY_PARAMS
} from './redaction-constants'
import { scrubQuery } from './scrub-url'

describe('declaredRedactedKeys', () => {
  it('keeps the names of a plugin, in order, without repeats', () => {
    expect(declaredRedactedKeys(['acmeSecret', 'acme_token', 'acmeSecret'])).toEqual([
      'acmeSecret',
      'acme_token'
    ])
  })

  it('takes nothing as no key', () => {
    expect(declaredRedactedKeys(undefined)).toEqual([])
  })

  it.each([
    ['not a list', 'acmeSecret'],
    ['a name that is not a string', [1]],
    ['an empty name', ['']],
    ['a name with a dot, which is a path', ['a.b']],
    ['a name with a wildcard', ['*']],
    ['a name with a bracket', ['a[0]']],
    ['a name with a quote', ['a"b']],
    ['a name that starts with a digit', ['1abc']],
    ['a name longer than 64 characters', ['a'.repeat(65)]],
    [
      'more names than the limit',
      Array.from({ length: MAX_DECLARED_REDACTED_KEYS + 1 }, (_, i) => `k${i}`)
    ]
  ])('refuses %s', (_label, keys) => {
    expect(() => declaredRedactedKeys(keys)).toThrow()
  })
})

// The names of the Meta webhook are not listed in the core: the rules by name cover them
describe('the secrets of a webhook that nobody lists', () => {
  it('reads the signature headers as secret by what the name says', () => {
    for (const name of ['x-hub-signature', 'x-hub-signature-256', 'X-Hub-Signature-256']) {
      expect(isSecretHeader(name)).toBe(true)
    }
  })

  it('redacts the handshake token by its suffix', () => {
    expect(scrubQuery({ 'hub.verify_token': 's3cret', 'hub.mode': 'subscribe' })).toEqual({
      'hub.verify_token': '[redacted]',
      'hub.mode': 'subscribe'
    })
  })

  it('has no provider in its lists', () => {
    const all = [...SENSITIVE_QUERY_PARAMS, ...REPORT_REDACTED_HEADERS]
    expect(all.filter(name => /hub|meta|instagram|whatsapp|messenger/i.test(name))).toEqual([])
  })
})
