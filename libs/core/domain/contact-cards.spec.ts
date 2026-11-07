import { sanitizeContactCard, sanitizeContactCards } from './contact-cards'
import { ContactCardLimits } from './message-metadata'

describe('sanitizeContactCard', () => {
  it('keeps the name, phones and emails with their kinds', () => {
    expect(
      sanitizeContactCard({
        name: 'Ana',
        phones: [{ number: '555', kind: 'CELL' }],
        emails: [{ address: 'a@example.com' }]
      })
    ).toEqual({
      name: 'Ana',
      phones: [{ number: '555', kind: 'CELL' }],
      emails: [{ address: 'a@example.com' }]
    })
  })

  it('reads each entry alone: one that does not fit is dropped and the rest stay', () => {
    const card = sanitizeContactCard({
      name: 'Ana',
      phones: [{ number: 5 }, { number: '555', kind: null }, 'x', null, { number: '666' }],
      emails: 'not a list'
    })
    expect(card?.phones).toEqual([{ number: '555' }, { number: '666' }])
    expect(card?.emails).toEqual([])
  })

  it('counts the cap after the blank entries are gone', () => {
    const blanks = Array.from({ length: ContactCardLimits.MAX_PHONES }, () => ({
      number: '\u0000'
    }))
    const card = sanitizeContactCard({ name: 'Ana', phones: [...blanks, { number: '777' }] })
    expect(card?.phones).toEqual([{ number: '777' }])
  })

  it('names a card by its first phone or email, and drops one with nothing', () => {
    expect(sanitizeContactCard({ name: '', phones: [{ number: '555' }] })?.name).toBe('555')
    expect(sanitizeContactCard({ emails: [{ address: 'a@example.com' }] })?.name).toBe(
      'a@example.com'
    )
    for (const raw of [{}, { name: '\u200F' }, null, 'x', [], { name: 3 }]) {
      expect(sanitizeContactCard(raw)).toBeNull()
    }
  })

  it('cuts and cleans every text', () => {
    const card = sanitizeContactCard({
      name: `${'n'.repeat(500)}\n`,
      phones: [{ number: '5'.repeat(500), kind: 'k'.repeat(500) }],
      emails: [{ address: `a\u0000${'e'.repeat(500)}` }]
    })
    expect(card?.name).toHaveLength(ContactCardLimits.NAME_MAX_LENGTH)
    expect(card?.phones[0]?.number).toHaveLength(ContactCardLimits.PHONE_MAX_LENGTH)
    expect(card?.phones[0]?.kind).toHaveLength(ContactCardLimits.KIND_MAX_LENGTH)
    expect(card?.emails[0]?.address.startsWith('a e')).toBe(true)
    expect(card?.emails[0]?.address).toHaveLength(ContactCardLimits.EMAIL_MAX_LENGTH)
  })
})

describe('sanitizeContactCards', () => {
  it('caps the cards, and one that does not fit costs only itself', () => {
    const many = Array.from({ length: ContactCardLimits.MAX_CONTACTS + 5 }, (_, index) => ({
      name: `C${index}`
    }))
    expect(sanitizeContactCards([null, ...many])).toHaveLength(ContactCardLimits.MAX_CONTACTS)
    expect(sanitizeContactCards('x')).toEqual([])
    expect(
      sanitizeContactCards([{ name: 'Ana' }, { name: 5 }, { name: 'Beto' }]).map(c => c.name)
    ).toEqual(['Ana', 'Beto'])
  })
})
