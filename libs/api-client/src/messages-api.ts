import { z } from 'zod'

import { ApiRoutes } from '@platform/core/api'
import type { MessageType } from '@platform/core/domain'

import type { ApiClient } from './api-client'
import {
  type DeletedContentView,
  deletedContentSchema,
  type MessagePageView,
  messagePageSchema,
  type MessageView,
  messageSchema,
  type RevisionView,
  revisionListSchema,
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
  // The message this one answers (the channel quotes it when it can)
  replyToMessageId?: string
}

// Files with their text under them: one message, one key. Each file was uploaded and confirmed first
// (`POST /media/confirm-upload`); they are sent in the order given, all of the type of the message, and the
// text is the caption of the first and may be left out. How many the channel takes is in the channel directory
// (`media`); the api refuses more, and while sending several is off it takes one.
export interface SendMediaMessageInput {
  type: MessageType.IMAGE | MessageType.VIDEO | MessageType.AUDIO | MessageType.DOCUMENT
  conversationId: string
  mediaIds: string[]
  content?: string
  // The text under each file by its place (`captions[i]` goes under `mediaIds[i]`; null or blank is none).
  // When it comes it wins over `content`. Under a file other than the first it is taken only by a channel
  // that declares `CAPTION_PER_FILE`; on any other the request is refused (409 `CHANNEL_CAPABILITY_UNSUPPORTED`).
  captions?: (string | null)[]
  idempotencyKey: string
  replyToMessageId?: string
}

export function sendMessage(
  client: ApiClient,
  storeId: string,
  input: SendMessageInput | SendMediaMessageInput
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

// "Send again" on a reply that failed: the same message goes back on its way as queued
export function resendMessage(
  client: ApiClient,
  storeId: string,
  messageId: string
): Promise<MessageView> {
  return client.request(ApiRoutes.messages.resend(messageId), {
    method: 'POST',
    schema: messageSchema,
    storeId
  })
}

// "Discard" on a reply known not to have gone out: it leaves the thread (the api answers 204, also when it
// was discarded already). A 409 means the screen was out of date: the thread is read again.
export function discardMessage(
  client: ApiClient,
  storeId: string,
  messageId: string
): Promise<void> {
  return client.request(ApiRoutes.messages.discard(messageId), {
    method: 'POST',
    schema: z.undefined(),
    storeId
  })
}

// "Send the text again" on a file whose caption failed or may not have gone: only the text is sent, and the
// message comes back with its caption queued
export function resendCaption(
  client: ApiClient,
  storeId: string,
  messageId: string
): Promise<MessageView> {
  return client.request(ApiRoutes.messages.resendCaption(messageId), {
    method: 'POST',
    schema: messageSchema,
    storeId
  })
}

// "Download it again" on a file of the customer that was lost: the worker fetches it from the provider
export function refetchFile(
  client: ApiClient,
  storeId: string,
  messageId: string,
  index: number
): Promise<MessageView> {
  return client.request(ApiRoutes.messages.refetchFile(messageId, index), {
    method: 'POST',
    schema: messageSchema,
    storeId
  })
}

// The reaction of the caller: an emoji sets it, null takes it back. The answer is 204.
export function reactToMessage(
  client: ApiClient,
  storeId: string,
  messageId: string,
  emoji: string | null
): Promise<void> {
  return client.request(ApiRoutes.messages.reaction(messageId), {
    method: 'PUT',
    body: { emoji },
    schema: z.undefined(),
    storeId
  })
}

// The whole new text. A note carries the `version` it was read at; a stale one answers 409.
export function editMessage(
  client: ApiClient,
  storeId: string,
  messageId: string,
  input: { content: string; version?: number }
): Promise<MessageView> {
  return client.request(ApiRoutes.messages.byId(messageId), {
    method: 'PATCH',
    body: input,
    schema: messageSchema,
    storeId
  })
}

// Deletes for everyone, or answers 409 when the channel cannot
export function deleteMessage(
  client: ApiClient,
  storeId: string,
  messageId: string
): Promise<void> {
  return client.request(ApiRoutes.messages.byId(messageId), {
    method: 'DELETE',
    schema: z.undefined(),
    storeId
  })
}

// Every read of the kept text is audited by the api
export function fetchDeletedContent(
  client: ApiClient,
  storeId: string,
  messageId: string
): Promise<DeletedContentView> {
  return client.request(ApiRoutes.messages.deletedContent(messageId), {
    schema: deletedContentSchema,
    storeId
  })
}

export function fetchRevisions(
  client: ApiClient,
  storeId: string,
  messageId: string,
  signal?: AbortSignal
): Promise<RevisionView[]> {
  return client.request(ApiRoutes.messages.revisions(messageId), {
    schema: revisionListSchema,
    storeId,
    signal
  })
}
