import { ApiRoutes } from '@platform/core/api'
import type { MessageType } from '@platform/core/domain'

import type { ApiClient } from './api-client'
import {
  type MessagePageView,
  messagePageSchema,
  type SentMessage,
  sentMessageSchema
} from './api-schemas'

// What POST /messages takes for the two kinds an agent writes. The key makes a retry return the
// message that exists instead of creating another one (the api answers 200 instead of 201).
export interface SendMessageInput {
  type: MessageType.TEXT | MessageType.INTERNAL_NOTE
  conversationId: string
  content: string
  idempotencyKey: string
  mentions?: string[]
}

export function sendMessage(
  client: ApiClient,
  storeId: string,
  input: SendMessageInput
): Promise<SentMessage> {
  return client.request(ApiRoutes.messages.create, {
    method: 'POST',
    body: input,
    schema: sentMessageSchema,
    storeId
  })
}

// One page of the thread, newest first; the cursor is the one the previous page gave
export function fetchMessagesPage(
  client: ApiClient,
  storeId: string,
  conversationId: string,
  cursor: string | null,
  signal?: AbortSignal
): Promise<MessagePageView> {
  const query = cursor === null ? '' : `?${new URLSearchParams({ cursor }).toString()}`
  return client.request(`${ApiRoutes.conversations.messages(conversationId)}${query}`, {
    schema: messagePageSchema,
    storeId,
    signal
  })
}

// A template is the only thing a customer outside the messaging window can be written. The key is
// made once for the dialog and reused by every retry, so a retry after a timeout cannot send it twice.
export interface SendTemplateInput {
  type: MessageType.TEMPLATE
  conversationId: string
  templateName: string
  language: string
  variables: string[]
  idempotencyKey: string
}

export function sendTemplate(
  client: ApiClient,
  storeId: string,
  input: SendTemplateInput
): Promise<SentMessage> {
  return client.request(ApiRoutes.messages.create, {
    method: 'POST',
    body: input,
    schema: sentMessageSchema,
    storeId
  })
}
