import { ApiRoutes } from '@platform/core/api'
import { WidgetAuthors, WidgetFieldIssues } from '@platform/core/domain'
import { ErrorCodes, HttpStatusCodes } from '@platform/core/errors'

import type {
  Attachment,
  Bootstrap,
  FileLink,
  ServerMessage,
  UploadSlot,
  VisitorProfile
} from './types'

// A refusal of the api, or no answer at all (`status` 0)
export class WidgetApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | null,
    // The `path` of each field the api named in a validation error
    readonly issuePaths: readonly string[] = []
  ) {
    super(`widget api ${status}`)
  }

  // The token is gone or was never good: ask for another
  get tokenInvalid(): boolean {
    return this.code === ErrorCodes.WIDGET_TOKEN_INVALID
  }

  // The api could not read the phone of the pre-chat form
  get phoneRefused(): boolean {
    return this.issuePaths.includes(WidgetFieldIssues.PHONE_PATH)
  }

  // A key that does not exist or a site that is not listed will not get better by waiting
  get permanent(): boolean {
    return this.status === HttpStatusCodes.FORBIDDEN || this.status === HttpStatusCodes.NOT_FOUND
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isAttachment(value: unknown): value is Attachment {
  return (
    isRecord(value) &&
    typeof value['id'] === 'string' &&
    typeof value['filename'] === 'string' &&
    typeof value['contentType'] === 'string' &&
    typeof value['size'] === 'number'
  )
}

export function isServerMessage(value: unknown): value is ServerMessage {
  return (
    isRecord(value) &&
    typeof value['id'] === 'string' &&
    (value['from'] === WidgetAuthors.VISITOR || value['from'] === WidgetAuthors.TEAM) &&
    typeof value['content'] === 'string' &&
    Array.isArray(value['attachments']) &&
    value['attachments'].every(isAttachment) &&
    typeof value['createdAt'] === 'string'
  )
}

function isFileLink(value: unknown): value is FileLink {
  return (
    isRecord(value) &&
    typeof value['url'] === 'string' &&
    typeof value['filename'] === 'string' &&
    typeof value['contentType'] === 'string' &&
    (value['previewUrl'] === null || typeof value['previewUrl'] === 'string')
  )
}

function isUploadSlot(value: unknown): value is UploadSlot {
  return (
    isRecord(value) &&
    typeof value['uploadUrl'] === 'string' &&
    typeof value['uploadId'] === 'string'
  )
}

function isBootstrap(value: unknown): value is Bootstrap {
  if (!isRecord(value) || !isRecord(value['store'])) return false
  return (
    typeof value['visitorToken'] === 'string' &&
    typeof value['expiresInSeconds'] === 'number' &&
    typeof value['store']['name'] === 'string' &&
    typeof value['store']['locale'] === 'string' &&
    typeof value['away'] === 'boolean' &&
    typeof value['preChat'] === 'boolean' &&
    Array.isArray(value['messages']) &&
    value['messages'].every(isServerMessage) &&
    (value['readUpToMessageId'] === null || typeof value['readUpToMessageId'] === 'string')
  )
}

function errorCodeOf(body: unknown): string | null {
  if (!isRecord(body) || !isRecord(body['error'])) return null
  const code = body['error']['code']
  return typeof code === 'string' ? code : null
}

function issuePathsOf(body: unknown): string[] {
  if (!isRecord(body) || !isRecord(body['error']) || !isRecord(body['error']['metadata'])) return []
  const issues = body['error']['metadata']['issues']
  if (!Array.isArray(issues)) return []
  return issues.flatMap(issue =>
    isRecord(issue) && typeof issue['path'] === 'string' ? [issue['path']] : []
  )
}

// The public calls of the widget. The token travels in the body, beside what it authorizes.
export class WidgetApi {
  constructor(
    private readonly apiUrl: string,
    private readonly request: typeof fetch = (...args) => fetch(...args)
  ) {}

  async bootstrap(siteKey: string, visitorId: string): Promise<Bootstrap> {
    const body = await this.post(ApiRoutes.widget.bootstrap, { siteKey, visitorId })
    if (!isBootstrap(body)) throw new WidgetApiError(0, null)
    return body
  }

  async send(
    visitorToken: string,
    clientMessageId: string,
    content: string,
    profile?: VisitorProfile,
    uploadIds: readonly string[] = []
  ): Promise<void> {
    await this.post(ApiRoutes.widget.messages, {
      visitorToken,
      clientMessageId,
      // A message of only files has no text to send
      ...(content === '' ? {} : { content }),
      ...(uploadIds.length === 0 ? {} : { uploadIds }),
      ...(profile === undefined ? {} : { profile })
    })
  }

  // Asks for a signed url to put one file on
  async requestUpload(
    visitorToken: string,
    file: { name: string; type: string; size: number }
  ): Promise<UploadSlot> {
    const body = await this.post(ApiRoutes.widget.upload, {
      visitorToken,
      filename: file.name,
      contentType: file.type,
      fileSizeBytes: file.size
    })
    if (!isUploadSlot(body)) throw new WidgetApiError(0, null)
    return body
  }

  // The link to open a file of the conversation, signed for a few minutes
  async fileLink(visitorToken: string, mediaId: string): Promise<FileLink> {
    const body = await this.post(ApiRoutes.widget.download, { visitorToken, mediaId })
    if (!isFileLink(body)) throw new WidgetApiError(0, null)
    return body
  }

  private async post(route: string, payload: object): Promise<unknown> {
    let response: Response
    try {
      response = await this.request(`${this.apiUrl}${route}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
        // The site is not logged in to the platform: nothing of the page's cookies goes along
        credentials: 'omit'
      })
    } catch {
      throw new WidgetApiError(0, null)
    }
    const body: unknown = await response.json().catch(() => null)
    if (!response.ok) {
      throw new WidgetApiError(response.status, errorCodeOf(body), issuePathsOf(body))
    }
    return body
  }
}
