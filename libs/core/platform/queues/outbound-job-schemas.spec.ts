import {
  outboundCaptionJobSchema,
  outboundDeleteJobSchema,
  outboundEditJobSchema,
  outboundMessageJobSchema,
  outboundReactionJobSchema,
  outboundReadReceiptJobSchema,
  outboundTypingJobSchema
} from './outbound-job-schemas'

// A different id for each field: a schema that reads one field from another fails
const STORE = '0b1f5a63-8d2e-4c4d-9a41-0a1b2c3d4e5f'
const MESSAGE = '1c2f6b74-9e3f-4d5e-8b52-1b2c3d4e5f60'
const USER = '2d307c85-af40-4e6f-9c63-2c3d4e5f6071'
const MEDIA = '3e418d96-b051-4f70-8d74-3d4e5f607182'
const CONVERSATION = '4f529ea7-c162-4081-9e85-4e5f60718293'

// Every key of the job type, set: what the api queues when it uses all of them. A schema that drops
// one of them fails here, besides failing to compile.
describe('the schemas of the outbound jobs', () => {
  const change = { storeId: STORE, messageId: MESSAGE, version: 3, correlationId: 'c' }
  const cases = [
    [
      'a reply',
      outboundMessageJobSchema,
      { storeId: STORE, messageId: MESSAGE, correlationId: 'c' }
    ],
    ['an edit', outboundEditJobSchema, change],
    ['a deletion', outboundDeleteJobSchema, change],
    ['a caption', outboundCaptionJobSchema, change],
    [
      'a reaction under one file of an album',
      outboundReactionJobSchema,
      {
        storeId: STORE,
        messageId: MESSAGE,
        userId: USER,
        version: 3,
        mediaId: MEDIA,
        correlationId: 'c'
      }
    ],
    [
      'a read receipt',
      outboundReadReceiptJobSchema,
      { storeId: STORE, conversationId: CONVERSATION, messageId: MESSAGE, correlationId: 'c' }
    ],
    [
      'a typing indicator',
      outboundTypingJobSchema,
      { storeId: STORE, conversationId: CONVERSATION, active: true, at: 5, correlationId: 'c' }
    ]
  ] as const

  it.each(cases)('keeps every field of %s', (_name, schema, job) => {
    expect(schema.parse(JSON.parse(JSON.stringify(job)))).toEqual(job)
  })

  it('accepts the file of a reaction whose id is not an RFC uuid, as the widget may choose it', () => {
    const job = {
      storeId: STORE,
      messageId: MESSAGE,
      userId: USER,
      version: 1,
      mediaId: '00000000-0000-0000-0000-000000000000'
    }
    expect(outboundReactionJobSchema.parse(job)).toEqual(job)
  })

  it('does not invent the optional fields', () => {
    const job = { storeId: STORE, messageId: MESSAGE, userId: USER, version: 1 }
    expect(outboundReactionJobSchema.parse(job)).toEqual(job)
  })

  it.each([
    ['an id that is no uuid', outboundMessageJobSchema, { storeId: 'x', messageId: MESSAGE }],
    ['a missing id', outboundMessageJobSchema, { storeId: STORE }],
    ['a fractional version', outboundEditJobSchema, { ...change, version: 1.5 }],
    ['a version that is no number', outboundDeleteJobSchema, { ...change, version: '3' }],
    [
      'a reaction file that is no uuid',
      outboundReactionJobSchema,
      {
        storeId: STORE,
        messageId: MESSAGE,
        userId: USER,
        version: 1,
        mediaId: 'x'
      }
    ],
    [
      'a typing flag that is no boolean',
      outboundTypingJobSchema,
      {
        storeId: STORE,
        conversationId: CONVERSATION,
        active: 'yes',
        at: 1
      }
    ]
  ])('refuses %s', (_name, schema, job) => {
    expect(schema.safeParse(job).success).toBe(false)
  })
})
