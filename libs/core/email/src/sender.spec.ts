import { DEFAULT_SENDER_NAME, senderOf } from './sender'

describe('senderOf', () => {
  it('gives a bare address the name of the product when none is set', () => {
    expect(senderOf('noreply@platform.local')).toBe(
      `"${DEFAULT_SENDER_NAME}" <noreply@platform.local>`
    )
  })

  it('gives a bare address the name that was set', () => {
    expect(senderOf('ventas@mitienda.com', 'Mi Tienda')).toBe('"Mi Tienda" <ventas@mitienda.com>')
    expect(senderOf(' ventas@mitienda.com ', '  Mi Tienda ')).toBe(
      '"Mi Tienda" <ventas@mitienda.com>'
    )
  })

  it('keeps a sender that already has a name, whatever EMAIL_FROM_NAME says', () => {
    expect(senderOf('Equipo <ventas@mitienda.com>', 'Mi Tienda')).toBe(
      'Equipo <ventas@mitienda.com>'
    )
  })

  it('reads an empty name as none', () => {
    expect(senderOf('a@b.com', '   ')).toBe(`"${DEFAULT_SENDER_NAME}" <a@b.com>`)
  })
})
