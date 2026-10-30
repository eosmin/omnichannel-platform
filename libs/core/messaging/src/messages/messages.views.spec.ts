import { AuthorType, MessageType } from '@platform/core/domain'

import { messageView } from './messages.views'

const row = (metadata: unknown): Parameters<typeof messageView>[0] => ({
  id: 'm1',
  conversationId: 'c1',
  type: MessageType.TEXT,
  content: 'hola',
  authorType: AuthorType.CUSTOMER,
  authorId: null,
  replyToMessageId: null,
  deliveryStatus: null,
  deliveryError: null,
  mentions: [],
  metadata,
  version: 1,
  editedAt: null,
  editedByType: null,
  editedById: null,
  pendingContent: null,
  editStatus: null,
  editError: null,
  deletedAt: null,
  deletedByType: null,
  deletedById: null,
  deleteStatus: null,
  deleteError: null,
  reactions: [],
  createdAt: new Date('2026-10-30T10:00:00Z')
})

describe('messageView attachmentUrl', () => {
  it('carries the link of a shared post as it came', () => {
    const view = messageView(row({ attachmentUrl: 'https://www.instagram.com/p/abc/' }))

    expect(view.attachmentUrl).toBe('https://www.instagram.com/p/abc/')
  })

  it.each([
    ['no metadata', null],
    ['metadata without a link', { attachmentType: 'ig_post' }],
    ['a javascript link', { attachmentUrl: 'javascript:alert(1)' }],
    ['a data link', { attachmentUrl: 'data:text/html,<script>1</script>' }],
    ['a link with credentials', { attachmentUrl: 'https://user:pass@example.com/' }],
    ['a link that is no text', { attachmentUrl: 42 }]
  ])('is null for %s', (_name, metadata) => {
    expect(messageView(row(metadata)).attachmentUrl).toBeNull()
  })

  it('never carries the rest of the metadata of the channel', () => {
    const view = messageView(row({ attachmentUrl: 'https://example.com/a', secret: 'x' }))

    expect(JSON.stringify(view)).not.toContain('secret')
  })
})
