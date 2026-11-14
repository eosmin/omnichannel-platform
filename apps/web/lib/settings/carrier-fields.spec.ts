import { carrierFieldHelpOf, carrierFieldLabelOf } from './carrier-fields'

const known = (key: string): string | null =>
  key === 'settings.carriers.connect.fields.x.user' ? 'User' : null

describe('the texts of a carrier field', () => {
  it('uses the page text for a key of its own section', () => {
    const field = { key: 'user', labelKey: 'settings.carriers.connect.fields.x.user', label: null }
    expect(carrierFieldLabelOf(field, 'en', known)).toBe('User')
  })

  it('never relabels a field with a key aimed at another section', () => {
    const field = { key: 'user', labelKey: 'settings.carriers.connect.fields.x.user', label: null }
    const elsewhere = { ...field, labelKey: 'settings.channels.connectDialog.title' }
    const answer = (key: string): string | null => (key === elsewhere.labelKey ? 'Hijacked' : null)
    expect(carrierFieldLabelOf(elsewhere, 'en', answer)).toBe('user')
  })

  it('falls back to the plugin own text in the language of the reader, then to the key', () => {
    const own = { key: 'k', labelKey: null, label: { es: 'Clave', en: 'Key' } }
    expect(carrierFieldLabelOf(own, 'es-GT', known)).toBe('Clave')
    expect(carrierFieldLabelOf(own, 'en', known)).toBe('Key')
    expect(carrierFieldLabelOf({ key: 'k', labelKey: null, label: null }, 'en', known)).toBe('k')
  })

  it('looks a line of help up only in its own section', () => {
    const help = (key: string): string | null =>
      key === 'settings.carriers.connect.fields.x.userHelp' ? 'Your user' : 'Other'
    expect(
      carrierFieldHelpOf({ helpKey: 'settings.carriers.connect.fields.x.userHelp' }, help)
    ).toBe('Your user')
    expect(carrierFieldHelpOf({ helpKey: 'settings.channels.x' }, help)).toBeNull()
    expect(carrierFieldHelpOf({ helpKey: null }, help)).toBeNull()
  })
})
