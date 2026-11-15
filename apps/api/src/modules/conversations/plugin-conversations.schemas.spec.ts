import { BulkActions, ConversationStatus } from '@platform/core/domain'

import {
  pluginBulkActionSchema,
  pluginChangeStatusSchema,
  startConversationSchema
} from './plugin-conversations.schemas'

const ID = '0f8fad5b-d9cb-469f-a165-70867728950e'

describe('what a plugin may ask of the inbox', () => {
  it('may change a status but not send the closing snippet', () => {
    expect(
      pluginChangeStatusSchema.safeParse({ status: ConversationStatus.RESOLVED }).success
    ).toBe(true)
    expect(
      pluginChangeStatusSchema.safeParse({
        status: ConversationStatus.RESOLVED,
        closingSnippetId: ID
      }).success
    ).toBe(false)
  })

  it('may act on many, but not assign to itself nor export a file', () => {
    const target = { conversationIds: [ID] }
    expect(
      pluginBulkActionSchema.safeParse({
        action: BulkActions.SET_STATUS,
        ...target,
        params: { status: ConversationStatus.RESOLVED }
      }).success
    ).toBe(true)
    expect(
      pluginBulkActionSchema.safeParse({ action: BulkActions.ASSIGN_TO_ME, ...target }).success
    ).toBe(false)
    expect(
      pluginBulkActionSchema.safeParse({ action: BulkActions.EXPORT_CSV, ...target }).success
    ).toBe(false)
  })

  it('starts a conversation from two ids and nothing else', () => {
    const body = { customerIdentityId: ID, channelConnectionId: ID }
    expect(startConversationSchema.safeParse(body).success).toBe(true)
    expect(startConversationSchema.safeParse({ ...body, storeId: ID }).success).toBe(false)
    expect(startConversationSchema.safeParse({ customerIdentityId: ID }).success).toBe(false)
  })
})
