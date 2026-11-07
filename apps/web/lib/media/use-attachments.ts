'use client'

import { useQueryClient } from '@tanstack/react-query'
import { useCallback, useEffect, useRef, useState } from 'react'

import {
  confirmUpload,
  fetchMediaUrls,
  QueryKeys,
  requestUploadUrl,
  sendMessage
} from '@platform/api-client'
import { ClientErrorCodes } from '@platform/core/errors'
import type { OutboundMediaType } from '@platform/core/storage'

import { apiClient } from '../api'
import { errorCodeOf } from '../error-message'

import { type BatchRefusal, type BatchRules, planAdd } from './attachment-batch'
import { attachmentMessageType } from './attachment-rules'
import { uploadGate } from './upload-gate'
import { UploadAbortedError, UploadFailedError, uploadToUrl } from './upload-to-url'
import { waitUntilClean } from './wait-until-clean'

// How many files of one message are on their way at the same time
const CONCURRENT_UPLOADS = 3

// uploading: bytes on their way (progress 0..1, or waiting for its turn at 0). checking: stored, waiting
// for the scan. ready: clean, can be sent. failed: the file is not part of the message and `code` says why.
export interface AttachmentItem {
  id: string
  file: File
  type: OutboundMediaType | null
  status: 'uploading' | 'checking' | 'ready' | 'failed'
  progress: number
  mediaId: string | null
  code: string | null
}

export interface Attachments {
  items: readonly AttachmentItem[]
  // Why the last files the person chose did not join (a mix of kinds, a message that is full)
  notice: Exclude<BatchRefusal, { kind: 'code' }> | null
  // The reason the last send failed, a code the person reads as any error
  sendError: string | null
  isSending: boolean
  add: (files: readonly File[]) => void
  remove: (id: string) => void
  clear: () => void
  // Sends the files that are ready, in the order they were chosen, with the text as the caption of the
  // first one, as one message. Resolves true when the api took it.
  send: (caption: string, replyToMessageId?: string) => Promise<boolean>
}

// The ones the channel of the conversation declares (`capabilities`, and `media`: what it takes of each kind).
// Unknown while the directory loads, which leaves the check to the api.
export type AttachmentRules = BatchRules

// The files the agent attaches to a reply: upload with progress, scan, and the single message that carries
// them with the caption. It does not go through the offline queue: an upload needs the network, so a file
// is never "written now and sent later". How many a message takes, and of which kind, is what the channel
// declares (`AttachmentRules`); a channel that says nothing takes one.
export function useAttachments(
  storeId: string,
  conversationId: string,
  rules: AttachmentRules
): Attachments {
  const queryClient = useQueryClient()
  // The list lives in a ref as well: an upload that ends reads the list as it is now, not as it was when it began
  const list = useRef<AttachmentItem[]>([])
  const [items, setItems] = useState<AttachmentItem[]>([])
  const [notice, setNotice] = useState<Attachments['notice']>(null)
  const [sendError, setSendError] = useState<string | null>(null)
  const [isSending, setSending] = useState(false)
  const controllers = useRef(new Map<string, AbortController>())
  const gate = useRef(uploadGate(CONCURRENT_UPLOADS))
  // One key per set of files: a retry after a timeout gives back the message that exists, and other files
  // are another message
  const sendKey = useRef<{ ids: string; key: string } | null>(null)
  const sending = useRef(false)
  const rulesRef = useRef(rules)
  rulesRef.current = rules

  const commit = useCallback((next: AttachmentItem[]): void => {
    list.current = next
    setItems(next)
  }, [])
  const patch = useCallback(
    (id: string, change: Partial<AttachmentItem>): void => {
      if (!list.current.some(item => item.id === id)) return
      commit(list.current.map(item => (item.id === id ? { ...item, ...change } : item)))
    },
    [commit]
  )

  const abortAll = useCallback((): void => {
    for (const controller of controllers.current.values()) controller.abort()
    controllers.current.clear()
  }, [])
  const clear = useCallback(() => {
    abortAll()
    commit([])
    setNotice(null)
    setSendError(null)
  }, [abortAll, commit])
  // Moving to another conversation (or closing the thread) drops the uploads that were going. The check
  // waits a tick: React in development unmounts and mounts a component once right after it appears, and
  // that must not cancel the files the composer handed over as it mounted.
  const isMounted = useRef(false)
  useEffect(() => {
    isMounted.current = true
    return () => {
      isMounted.current = false
      setTimeout(() => {
        if (!isMounted.current) abortAll()
      }, 0)
    }
  }, [abortAll])

  const remove = useCallback(
    (id: string) => {
      controllers.current.get(id)?.abort()
      controllers.current.delete(id)
      commit(list.current.filter(item => item.id !== id))
      setNotice(null)
      setSendError(null)
    },
    [commit]
  )

  const upload = useCallback(
    async (item: AttachmentItem, controller: AbortController): Promise<void> => {
      const { file, id } = item
      try {
        const info = { filename: file.name, contentType: file.type, fileSizeBytes: file.size }
        const mediaId = await gate.current(async () => {
          const signed = await requestUploadUrl(apiClient, storeId, info)
          controller.signal.throwIfAborted()
          await uploadToUrl(
            signed.uploadUrl,
            file,
            file.type,
            progress => patch(id, { progress }),
            controller.signal
          )
          const media = await confirmUpload(apiClient, storeId, {
            ...info,
            mediaId: signed.mediaId,
            key: signed.key
          })
          return media.id
        }, controller.signal)
        patch(id, { status: 'checking', mediaId })
        await waitUntilClean(() => fetchMediaUrls(apiClient, storeId, mediaId), {
          signal: controller.signal
        })
        patch(id, { status: 'ready' })
      } catch (error) {
        if (controller.signal.aborted || error instanceof UploadAbortedError) return
        patch(id, {
          status: 'failed',
          code:
            error instanceof UploadFailedError
              ? ClientErrorCodes.FILE_UPLOAD_FAILED
              : errorCodeOf(error)
        })
      }
    },
    [patch, storeId]
  )

  const add = useCallback(
    (files: readonly File[]) => {
      const held = list.current.filter(item => item.status !== 'failed').map(item => item.type)
      const plan = planAdd(
        held,
        files.map(({ type, size }) => ({ type, size })),
        rulesRef.current
      )
      const added: AttachmentItem[] = []
      let refused: Attachments['notice'] = null
      files.forEach((file, at) => {
        const refusal = plan[at] ?? null
        if (refusal?.kind === 'mixed' || refusal?.kind === 'full') {
          refused = refusal
          return
        }
        added.push({
          id: crypto.randomUUID(),
          file,
          type: attachmentMessageType(file.type),
          status: refusal === null ? 'uploading' : 'failed',
          progress: 0,
          mediaId: null,
          code: refusal?.kind === 'code' ? refusal.code : null
        })
      })
      setNotice(refused)
      setSendError(null)
      if (added.length === 0) return
      commit([...list.current, ...added])
      for (const item of added) {
        if (item.status === 'failed') continue
        const controller = new AbortController()
        controllers.current.set(item.id, controller)
        void upload(item, controller)
      }
    },
    [commit, upload]
  )

  const send = useCallback(
    async (caption: string, replyToMessageId?: string): Promise<boolean> => {
      const ready = list.current.filter(item => item.status === 'ready')
      const type = ready[0]?.type
      // A file still on its way is not left behind: sending waits until every file has settled
      const isSettling = list.current.some(
        item => item.status === 'uploading' || item.status === 'checking'
      )
      if (
        ready.length === 0 ||
        isSettling ||
        type === null ||
        type === undefined ||
        sending.current
      ) {
        return false
      }
      const mediaIds = ready.flatMap(item => (item.mediaId === null ? [] : [item.mediaId]))
      // The key names this message: other files, another caption or another quote are another request
      const ids = JSON.stringify([mediaIds, caption, replyToMessageId ?? null])
      if (sendKey.current?.ids !== ids) sendKey.current = { ids, key: crypto.randomUUID() }
      const { key } = sendKey.current
      sending.current = true
      setSending(true)
      setSendError(null)
      try {
        await sendMessage(apiClient, storeId, {
          type,
          conversationId,
          mediaIds,
          ...(caption === '' ? {} : { content: caption }),
          ...(replyToMessageId === undefined ? {} : { replyToMessageId }),
          idempotencyKey: key
        })
        sendKey.current = null
        clear()
        await queryClient.invalidateQueries({
          queryKey: QueryKeys.messages.thread(storeId, conversationId)
        })
        return true
      } catch (error) {
        setSendError(errorCodeOf(error))
        return false
      } finally {
        sending.current = false
        setSending(false)
      }
    },
    [clear, conversationId, queryClient, storeId]
  )

  return { items, notice, sendError, isSending, add, remove, clear, send }
}
