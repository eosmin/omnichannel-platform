import {
  canonicalWebhookUrl,
  createWebhookSchema,
  updateWebhookSchema
} from './tenant-webhooks.schemas'

const EVENTS = ['order.created']

describe('canonicalWebhookUrl', () => {
  it.each([
    ['https://example.com/hook', 'https://example.com/hook'],
    ['https://EXAMPLE.com/hook', 'https://example.com/hook'],
    ['https://example.com:443/hook', 'https://example.com/hook'],
    ['https://example.com./hook', 'https://example.com/hook'],
    ['https://Example.COM.:443/hook', 'https://example.com/hook'],
    ['https://example.com../hook', 'https://example.com/hook'],
    ['https://example.com.', 'https://example.com/'],
    ['https://example.com.:8443/hook', 'https://example.com:8443/hook'],
    ['https://sub.example.com./a?b=1', 'https://sub.example.com/a?b=1']
  ])('writes %s as %s', (raw, expected) => {
    expect(canonicalWebhookUrl(raw)).toBe(expected)
  })

  it('leaves the path, the query and a different host alone', () => {
    expect(canonicalWebhookUrl('https://example.com.evil.test/hook')).toBe(
      'https://example.com.evil.test/hook'
    )
    expect(canonicalWebhookUrl('https://example.com/a.')).toBe('https://example.com/a.')
  })
})

describe('createWebhookSchema address', () => {
  it('reads the host with and without its final dot as the same address', () => {
    const plain = createWebhookSchema.parse({ url: 'https://example.com/hook', events: EVENTS })
    const dotted = createWebhookSchema.parse({ url: 'https://example.com./hook', events: EVENTS })
    expect(dotted.url).toBe(plain.url)
  })

  it('reads the address of a change the same way', () => {
    const changed = updateWebhookSchema.parse({ url: 'https://Example.com./hook' })
    expect(changed.url).toBe('https://example.com/hook')
  })

  it.each(['https://./hook', 'https://../hook'])('refuses %s, a host made only of dots', raw => {
    expect(createWebhookSchema.safeParse({ url: raw, events: EVENTS }).success).toBe(false)
  })
})
