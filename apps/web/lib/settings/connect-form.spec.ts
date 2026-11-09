import type { ConnectFieldView } from './channels-requests'
import { fieldLabelOf, credentialsOf, emptyValues, linesOf, missingFields } from './connect-form'

const field = (key: string, over: Partial<ConnectFieldView> = {}): ConnectFieldView => ({
  key,
  labelKey: `settings.channels.connect.x.${key}`,
  label: null,
  helpKey: null,
  secret: false,
  required: true,
  multiple: false,
  ...over
})

describe('linesOf', () => {
  it('keeps one entry per line, trimmed, without blanks or repeats', () => {
    expect(linesOf(' https://a.com \r\n\n https://b.com\nhttps://a.com\n  ')).toEqual([
      'https://a.com',
      'https://b.com'
    ])
  })

  it('answers an empty list for no text', () => {
    expect(linesOf('')).toEqual([])
  })
})

describe('the connect form', () => {
  const fields = [
    field('phoneNumberId'),
    field('accessToken', { secret: true }),
    field('note', { required: false }),
    field('siteOrigins', { multiple: true })
  ]

  it('starts empty for every field the plugin asks for', () => {
    expect(emptyValues(fields)).toEqual({
      phoneNumberId: '',
      accessToken: '',
      note: '',
      siteOrigins: ''
    })
  })

  it('names the required fields that have nothing typed, counting a blank as nothing', () => {
    const values = { ...emptyValues(fields), phoneNumberId: '   ', accessToken: 'tok' }
    expect(missingFields(fields, values).map(item => item.key)).toEqual([
      'phoneNumberId',
      'siteOrigins'
    ])
  })

  it('counts a list with only blank lines as missing', () => {
    const values = {
      ...emptyValues(fields),
      phoneNumberId: '1',
      accessToken: 't',
      siteOrigins: '\n \n'
    }
    expect(missingFields(fields, values).map(item => item.key)).toEqual(['siteOrigins'])
  })

  it('sends only what was typed: trimmed text, lists as arrays, no empty optional field', () => {
    const values = {
      phoneNumberId: ' 123 ',
      accessToken: 'secret-token',
      note: '  ',
      siteOrigins: 'https://a.com\nhttps://b.com'
    }
    expect(missingFields(fields, values)).toEqual([])
    expect(credentialsOf(fields, values)).toEqual({
      phoneNumberId: '123',
      accessToken: 'secret-token',
      siteOrigins: ['https://a.com', 'https://b.com']
    })
  })

  it('sends nothing for a key the plugin did not declare', () => {
    expect(credentialsOf(fields, { ...emptyValues(fields), extra: 'x' })).toEqual({})
  })
})

describe('fieldLabelOf', () => {
  const own = { key: 'apiKey', labelKey: null, label: { es: 'Clave de Acme', en: 'Acme API key' } }
  const known = (key: string): string | null => (key === 'settings.channels.x' ? 'Known' : null)

  it('draws the message of the page where the field names one it has', () => {
    expect(
      fieldLabelOf({ key: 'k', labelKey: 'settings.channels.x', label: null }, 'en', known)
    ).toBe('Known')
  })

  it('draws the text the plugin wrote, in the language of the reader', () => {
    expect(fieldLabelOf(own, 'es', known)).toBe('Clave de Acme')
    expect(fieldLabelOf(own, 'en', known)).toBe('Acme API key')
    expect(fieldLabelOf(own, 'es-MX', known)).toBe('Clave de Acme')
  })

  it('does not let a key aimed at another part of the page relabel a field', () => {
    expect(fieldLabelOf({ ...own, labelKey: 'common.cancel' }, 'en', () => 'Cancel')).toBe(
      'Acme API key'
    )
  })

  it('shows the key of a field it cannot name', () => {
    expect(
      fieldLabelOf({ key: 'k', labelKey: 'settings.channels.unknown', label: null }, 'en', known)
    ).toBe('k')
  })
})
