import {
  ContactCardLimits,
  InboundLimits,
  MessageMetadataKeys,
  MessageType
} from '@platform/core/domain'

import { webhookToEvents } from './whatsapp-events'

const PHONE = '106540352242922'

const received = (message: object): ReturnType<typeof webhookToEvents>[number] | undefined =>
  webhookToEvents({
    object: 'whatsapp_business_account',
    entry: [
      {
        id: '1',
        changes: [
          {
            field: 'messages',
            value: {
              metadata: { phone_number_id: PHONE },
              messages: [
                { from: '15550001111', id: 'wamid.1', timestamp: '1761600000', ...message }
              ]
            }
          }
        ]
      }
    ]
  })[0]

const card = (name: string, extra: object = {}): object => ({
  name: { formatted_name: name, first_name: name },
  ...extra
})

describe('a contact card shared on WhatsApp', () => {
  it('is a CONTACTS message with the names, phones and emails and nothing else of the card', () => {
    const event = received({
      type: 'contacts',
      contacts: [
        card('Ana Pérez', {
          phones: [
            { phone: '+52 55 1234 5678', wa_id: '525512345678', type: 'CELL' },
            { wa_id: '525599999999' }
          ],
          emails: [{ email: 'ana@example.com', type: 'WORK' }],
          addresses: [{ street: '1 Main St', city: 'Mexico City' }],
          birthday: '1990-01-01',
          org: { company: 'ACME' },
          urls: [{ url: 'https://example.com' }]
        })
      ]
    })

    expect(event?.message).toEqual({
      externalId: 'wamid.1',
      replyToExternalId: undefined,
      timestamp: '2025-10-27T21:20:00.000Z',
      type: MessageType.CONTACTS,
      content: 'Ana Pérez',
      metadata: {
        [MessageMetadataKeys.CONTACTS]: [
          {
            name: 'Ana Pérez',
            phones: [{ number: '+52 55 1234 5678', kind: 'CELL' }, { number: '525599999999' }],
            emails: [{ address: 'ana@example.com', kind: 'WORK' }]
          }
        ]
      }
    })
  })

  it('lists the names of several cards in the content', () => {
    const event = received({
      type: 'contacts',
      contacts: [
        card('Ana', { phones: [{ phone: '1' }] }),
        card('Beto', { phones: [{ phone: '2' }] })
      ]
    })
    expect(event?.message?.content).toBe('Ana, Beto')
  })

  it('names a card by its parts, or by what reaches it, when there is no formatted name', () => {
    const event = received({
      type: 'contacts',
      contacts: [
        { name: { first_name: 'Ana', last_name: 'Pérez' } },
        { phones: [{ phone: '555' }] },
        { emails: [{ email: 'x@example.com' }] }
      ]
    })
    const cards = event?.message?.metadata?.[MessageMetadataKeys.CONTACTS] as { name: string }[]
    expect(cards.map(item => item.name)).toEqual(['Ana Pérez', '555', 'x@example.com'])
  })

  it('skips a card with nothing in it and keeps the ones beside it', () => {
    const event = received({
      type: 'contacts',
      contacts: [{}, 'x', null, { name: {} }, card('Ana')]
    })
    expect(event?.message).toMatchObject({ type: MessageType.CONTACTS, content: 'Ana' })
  })

  it('is the marker of its type when no card can be read', () => {
    for (const contacts of [[], [{}], 'x', undefined]) {
      expect(received({ type: 'contacts', contacts })?.message).toMatchObject({
        type: MessageType.TEXT,
        content: '[contacts]',
        metadata: { [MessageMetadataKeys.UNSUPPORTED_TYPE]: 'contacts' }
      })
    }
  })

  it('caps the cards, the phones and the emails, and cuts every text', () => {
    const many = Array.from({ length: ContactCardLimits.MAX_CONTACTS + 5 }, (_, index) =>
      card(`C${index}`, { phones: [{ phone: '1' }] })
    )
    const cards = received({ type: 'contacts', contacts: many })?.message?.metadata?.[
      MessageMetadataKeys.CONTACTS
    ] as unknown[]
    expect(cards).toHaveLength(ContactCardLimits.MAX_CONTACTS)

    const big = received({
      type: 'contacts',
      contacts: [
        card('n'.repeat(5000), {
          phones: Array.from({ length: 20 }, (_, index) => ({ phone: `${index}`.repeat(100) })),
          emails: Array.from({ length: 20 }, () => ({
            email: `${'e'.repeat(500)}@example.com`,
            type: 'T'.repeat(500)
          }))
        })
      ]
    })?.message?.metadata?.[MessageMetadataKeys.CONTACTS] as {
      name: string
      phones: { number: string }[]
      emails: { address: string; kind: string }[]
    }[]
    expect(big[0]?.name).toHaveLength(ContactCardLimits.NAME_MAX_LENGTH)
    expect(big[0]?.phones).toHaveLength(ContactCardLimits.MAX_PHONES)
    expect(big[0]?.phones[0]?.number.length).toBeLessThanOrEqual(ContactCardLimits.PHONE_MAX_LENGTH)
    expect(big[0]?.emails).toHaveLength(ContactCardLimits.MAX_EMAILS)
    expect(big[0]?.emails[0]?.address.length).toBeLessThanOrEqual(
      ContactCardLimits.EMAIL_MAX_LENGTH
    )
    expect(big[0]?.emails[0]?.kind.length).toBeLessThanOrEqual(ContactCardLimits.KIND_MAX_LENGTH)
  })

  it('never makes metadata the core would refuse, even with the widest characters', () => {
    // Three bytes a character in JSON: the caps on counts alone would give about 10 000 bytes
    const wide = '€'
    const event = received({
      type: 'contacts',
      contacts: Array.from({ length: 10 }, () => ({
        name: { formatted_name: wide.repeat(200) },
        phones: Array.from({ length: 5 }, () => ({
          phone: wide.repeat(32),
          type: wide.repeat(32)
        })),
        emails: Array.from({ length: 3 }, () => ({
          email: wide.repeat(254),
          type: wide.repeat(32)
        }))
      }))
    })
    const bytes = Buffer.byteLength(JSON.stringify(event?.message?.metadata))
    expect(bytes).toBeLessThanOrEqual(InboundLimits.METADATA_MAX_BYTES)
    expect(event?.message?.type).toBe(MessageType.CONTACTS)
  })

  it('takes out of a name the characters that reorder text', () => {
    const event = received({ type: 'contacts', contacts: [card('Ana‮ gnihsihp')] })
    expect(event?.message?.content).not.toContain('‮')
  })

  it('turns control characters into spaces, so a NUL or a line break cannot reach the database or forge a line', () => {
    const event = received({
      type: 'contacts',
      contacts: [
        card('Ana\u0000\nPago: transfiere', {
          phones: [{ phone: '55\u00005' }],
          emails: [{ email: 'a@example.com\r\n' }]
        })
      ]
    })
    expect(event?.message?.content).toBe('Ana Pago: transfiere')
    expect(JSON.stringify(event?.message)).not.toMatch(/\\u0000|\\n|\\r/)
  })

  it('takes the wa_id when the phone is empty or has nothing visible', () => {
    for (const phone of ['', '\u200F ', '\u0000']) {
      const event = received({
        type: 'contacts',
        contacts: [card('Ana', { phones: [{ phone, wa_id: '525512345678' }] })]
      })
      const [first] = event?.message?.metadata?.[MessageMetadataKeys.CONTACTS] as {
        phones: { number: string }[]
      }[]
      expect(first?.phones).toEqual([{ number: '525512345678' }])
    }
  })

  it('stops at the byte cap in the middle of the list and keeps the message with the cards before it', () => {
    const wide = '\u20AC'
    const heavy = card(wide.repeat(200), {
      phones: Array.from({ length: 5 }, () => ({ phone: wide.repeat(32) })),
      emails: Array.from({ length: 3 }, () => ({ email: wide.repeat(254) }))
    })
    const event = received({
      type: 'contacts',
      contacts: [card('Ana'), heavy, heavy, heavy, card('Beto')]
    })
    const cards = event?.message?.metadata?.[MessageMetadataKeys.CONTACTS] as { name: string }[]
    expect(cards[0]?.name).toBe('Ana')
    expect(cards.length).toBeGreaterThan(1)
    expect(cards.length).toBeLessThan(5)
    expect(event?.message?.type).toBe(MessageType.CONTACTS)
  })
})
