import { isPluginCheck, PluginChecks } from './plugin-checks'

describe('isPluginCheck', () => {
  it.each(Object.values(PluginChecks))('accepts the check %s', check => {
    expect(isPluginCheck(check)).toBe(true)
  })

  it.each([undefined, null, 7, {}, 'Bearer EAAB-secret', 'not_a_check', ''])(
    'refuses %p, so a plugin cannot put text of its own where a check name goes',
    value => {
      expect(isPluginCheck(value)).toBe(false)
    }
  )
})

// The list is closed and made of plain names: a free-text entry (a sentence, a value) must never be added,
// because these names are logged and may travel as `metadata.reason`
describe('PluginChecks', () => {
  it.each(Object.values(PluginChecks))(
    'names %s with lowercase letters and underscores only',
    check => {
      expect(check).toMatch(/^[a-z]+(_[a-z]+)*$/)
    }
  )
})
