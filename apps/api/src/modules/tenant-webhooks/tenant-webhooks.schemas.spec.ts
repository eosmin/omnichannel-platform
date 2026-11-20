import { canonicalWebhookUrl, createWebhookSchema } from './tenant-webhooks.schemas'

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
})
