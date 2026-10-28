// Webhook bodies in the shape the WhatsApp Cloud API sends them (messages field, v23.0), kept from a
// test number with the people and numbers replaced. The ids are made up.
export const WHATSAPP_PHONE_NUMBER_ID = '106540352242922'
export const WHATSAPP_BUSINESS_ACCOUNT_ID = '102290129340398'
export const WHATSAPP_CUSTOMER = '15550001111'

const metadata = {
  display_phone_number: '15551234567',
  phone_number_id: WHATSAPP_PHONE_NUMBER_ID
}

function envelope(value: object): object {
  return {
    object: 'whatsapp_business_account',
    entry: [
      {
        id: WHATSAPP_BUSINESS_ACCOUNT_ID,
        changes: [
          { field: 'messages', value: { messaging_product: 'whatsapp', metadata, ...value } }
        ]
      }
    ]
  }
}

export const inboundTextWebhook = envelope({
  contacts: [{ profile: { name: 'Test Customer' }, wa_id: WHATSAPP_CUSTOMER }],
  messages: [
    {
      from: WHATSAPP_CUSTOMER,
      id: 'wamid.HBgLMTU1NTAwMDExMTEVAgASGBQzQUZCMDk',
      timestamp: '1761600000',
      type: 'text',
      text: { body: 'Hola, quiero hacer un pedido' }
    }
  ]
})

export const inboundImageWebhook = envelope({
  contacts: [{ profile: { name: 'Test Customer' }, wa_id: WHATSAPP_CUSTOMER }],
  messages: [
    {
      from: WHATSAPP_CUSTOMER,
      id: 'wamid.HBgLMTU1NTAwMDExMTEVAgASGBQzQUZCMDl',
      timestamp: '1761600060',
      type: 'image',
      context: { from: '15551234567', id: 'wamid.HBgLMTU1NTUxMjM0NTY3FQIAERgSQ0E' },
      image: {
        id: '1234567890123456',
        mime_type: 'image/jpeg',
        sha256: 'Zm9v',
        caption: 'Este es el modelo'
      }
    }
  ]
})

export const statusWebhook = (status: 'sent' | 'delivered' | 'read'): object =>
  envelope({
    statuses: [
      {
        id: 'wamid.HBgLMTU1NTUxMjM0NTY3FQIAERgSQ0E',
        status,
        timestamp: '1761600120',
        recipient_id: WHATSAPP_CUSTOMER,
        conversation: { id: 'c1', origin: { type: 'service' } },
        pricing: { billable: false, pricing_model: 'PMP', category: 'service' }
      }
    ]
  })

export const failedStatusWebhook = envelope({
  statuses: [
    {
      id: 'wamid.HBgLMTU1NTUxMjM0NTY3FQIAERgSQ0E',
      status: 'failed',
      timestamp: '1761600180',
      recipient_id: WHATSAPP_CUSTOMER,
      errors: [{ code: 131047, title: 'Re-engagement message', message: 'Re-engagement message' }]
    }
  ]
})

// A valid payload that carries nothing to do
export const emptyWebhook = envelope({})
