import { normalizePhone } from './phone'

describe('normalizePhone', () => {
  it('reads a number with its country code', () => {
    expect(normalizePhone('+503 7123-4567')).toEqual({
      display: '+503 7123 4567',
      digits: '50371234567'
    })
  })

  it('puts the default region on a national number', () => {
    expect(normalizePhone('7123-4567')?.digits).toBe('50371234567')
  })

  it('reads the international prefix 00', () => {
    expect(normalizePhone('00503 7123 4567')?.digits).toBe('50371234567')
  })

  it('reads the digits a channel sends, without a plus', () => {
    expect(normalizePhone('50371234567', { fromChannel: true })?.digits).toBe('50371234567')
    expect(normalizePhone('525512345678', { fromChannel: true })?.digits).toBe('525512345678')
  })

  it('does not guess a country for the digits a person typed', () => {
    // A Mexican number without its country code is not the Brazilian +55 12345678
    expect(normalizePhone('5512345678')).toBeNull()
    expect(normalizePhone('50371234567')?.digits).toBe('50371234567')
  })

  it('refuses text around the number and extensions', () => {
    expect(normalizePhone('Mi numero es 7123-4567')).toBeNull()
    expect(normalizePhone('7123-4567 ext. 12')).toBeNull()
  })

  it('refuses what is not a valid number', () => {
    expect(normalizePhone('12345')).toBeNull()
    expect(normalizePhone('not a phone')).toBeNull()
    expect(normalizePhone('')).toBeNull()
  })

  it('gives the same digits however the number is typed', () => {
    const forms = ['+50371234567', '+503 7123 4567', '(503) 7123-4567', '7123 4567']
    // Each form gives the same digits, and they are the digits of the number
    expect(forms.map(form => normalizePhone(form)?.digits)).toEqual(forms.map(() => '50371234567'))
  })
})
