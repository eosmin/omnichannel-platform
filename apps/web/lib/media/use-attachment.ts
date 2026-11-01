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
import { ErrorCodes, type ErrorCode } from '@platform/core/errors'

import { apiClient } from '../api'
import { errorCodeOf } from '../error-message'

import {
  attachmentMessageType,
  channelTakesFile,
  refusalCode,
  refuseAttachment
} from './attachment-rules'
import { UploadAbortedError, UploadFailedError, uploadToUrl } from './upload-to-url'
import { waitUntilClean } from './wait-until-clean'

export interface AttachmentFile {
  name: string
  size: number
  contentType: string
}

// idle: nothing attached. uploading: bytes on their way (progress 0..1). checking: stored, waiting for
// the scan. ready: clean, can be sent. failed: the attachment is dropped and `code` says why.
export type AttachmentState =
  | { kind: 'idle' }
  | { kind: 'uploading'; file: AttachmentFile; progress: number }
  | { kind: 'checking'; file: AttachmentFile }
  | { kind: 'ready'; file: AttachmentFile; sendError: ErrorCode | null; isSending: boolean }
  | { kind: 'failed'; file: AttachmentFile; code: ErrorCode }

export interface Attachment {
  state: AttachmentState
  attach: (file: File) => void
  // Takes the attachment away: cancels an upload that is still going
  clear: () => void
  // Sends the file with its caption as one message. Resolves true when the api took it.
  send: (caption: string) => Promise<boolean>
}

const IDLE: AttachmentState = { kind: 'idle' }

// The file the agent attaches to a reply: upload with progress, scan, and the single message that
// carries it with its caption. It does not go through the offline queue: an upload needs the network,
// so a file is never "written now and sent later". One file at a time (MediaMessageLimits.MAX_FILES).
// `capabilities` are the ones the channel of the conversation declares; unknown (the directory is still
// loading) leaves the check to the api.
export function useAttachment(
  storeId: string,
  conversationId: string,
  capabilities?: readonly string[]
): Attachment {
  const queryClient = useQueryClient()
  const [state, setState] = useState<AttachmentState>(IDLE)
  const run = useRef<{
    controller: AbortController
    mediaId: string | null
    key: string
    sending: boolean
    type: ReturnType<typeof attachmentMessageType>
  } | null>(null)

  const clear = useCallback(() => {
    run.current?.controller.abort()
    run.current = null
    setState(IDLE)
  }, [])

  // Moving to another conversation (or closing the thread) drops the upload that was going
  useEffect(() => () => run.current?.controller.abort(), [])

  const attach = useCallback(
    (file: File) => {
      run.current?.controller.abort()
      const meta: AttachmentFile = { name: file.name, size: file.size, contentType: file.type }
      const refusal = refuseAttachment(file)
      if (refusal !== null) {
        run.current = null
        setState({ kind: 'failed', file: meta, code: refusalCode(refusal) })
        return
      }
      if (capabilities !== undefined && !channelTakesFile(capabilities, file.type)) {
        run.current = null
        setState({ kind: 'failed', file: meta, code: ErrorCodes.CHANNEL_CAPABILITY_UNSUPPORTED })
        return
      }
      const controller = new AbortController()
      const current = {
        controller,
        mediaId: null as string | null,
        key: crypto.randomUUID(),
        sending: false,
        type: attachmentMessageType(file.type)
      }
      run.current = current
      const isCurrent = (): boolean => run.current === current

      void (async () => {
        try {
          const info = {
            filename: file.name,
            contentType: file.type,
            fileSizeBytes: file.size
          }
          setState({ kind: 'uploading', file: meta, progress: 0 })
          const signed = await requestUploadUrl(apiClient, storeId, info)
          controller.signal.throwIfAborted()
          await uploadToUrl(
            signed.uploadUrl,
            file,
            file.type,
            progress => {
              if (isCurrent()) setState({ kind: 'uploading', file: meta, progress })
            },
            controller.signal
          )
          const media = await confirmUpload(apiClient, storeId, {
            ...info,
            mediaId: signed.mediaId,
            key: signed.key
          })
          current.mediaId = media.id
          if (!isCurrent()) return
          setState({ kind: 'checking', file: meta })
          await waitUntilClean(() => fetchMediaUrls(apiClient, storeId, media.id), {
            signal: controller.signal
          })
          if (isCurrent()) {
            setState({ kind: 'ready', file: meta, sendError: null, isSending: false })
          }
        } catch (error) {
          if (!isCurrent() || controller.signal.aborted || error instanceof UploadAbortedError) {
            return
          }
          setState({
            kind: 'failed',
            file: meta,
            code:
              error instanceof UploadFailedError
                ? ErrorCodes.FILE_UPLOAD_FAILED
                : errorCodeOf(error)
          })
        }
      })()
    },
    [storeId, capabilities]
  )

  const send = useCallback(
    async (caption: string): Promise<boolean> => {
      const current = run.current
      if (current === null || current.mediaId === null || current.type === null) return false
      const { mediaId, type } = current
      if (current.sending) return false
      current.sending = true
      setState(previous =>
        previous.kind === 'ready' ? { ...previous, isSending: true, sendError: null } : previous
      )
      try {
        await sendMessage(apiClient, storeId, {
          type,
          conversationId,
          mediaIds: [mediaId],
          ...(caption === '' ? {} : { content: caption }),
          // One key per attachment: a retry after a timeout gives back the message that exists
          idempotencyKey: current.key
        })
        if (run.current === current) {
          run.current = null
          setState(IDLE)
        }
        await queryClient.invalidateQueries({
          queryKey: QueryKeys.messages.thread(storeId, conversationId)
        })
        return true
      } catch (error) {
        current.sending = false
        if (run.current === current) {
          setState(previous =>
            previous.kind === 'ready'
              ? { ...previous, isSending: false, sendError: errorCodeOf(error) }
              : previous
          )
        }
        return false
      }
    },
    [conversationId, queryClient, storeId]
  )

  return { state, attach, clear, send }
}
