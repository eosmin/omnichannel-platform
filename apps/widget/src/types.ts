import type { WidgetAuthor, WidgetDeliveryState } from '@platform/core/domain'

// What the api answers (apps/api/src/modules/widget): the script is served on other people's sites and
// cannot trust it blindly, so api.ts checks the shape before any of it is used.
export interface ServerMessage {
  id: string
  from: WidgetAuthor
  // The text, or the caption of the files; empty when the message is only files
  content: string
  attachments: Attachment[]
  createdAt: string
}

// A file of a message. Its link is never here: it is asked for when the visitor opens the file.
export interface Attachment {
  // The id the download route takes. A file still going up has none.
  id: string | null
  filename: string
  contentType: string
  size: number
}

// What `POST /widget/download-url` answers
export interface FileLink {
  url: string
  filename: string
  contentType: string
  previewUrl: string | null
}

// What the api answers when asked to sign an upload
export interface UploadSlot {
  uploadUrl: string
  uploadId: string
}

// What the pre-chat form collects; every field is optional and none is proved
export interface VisitorProfile {
  name?: string
  email?: string
  phone?: string
}

export interface Bootstrap {
  visitorToken: string
  expiresInSeconds: number
  store: { name: string; locale: string }
  away: boolean
  // The store asks for a name, an email and a phone before the first message
  preChat: boolean
  messages: ServerMessage[]
  // The latest message of the visitor that an agent read; null when none was
  readUpToMessageId: string | null
}

// A line of the conversation. A message the visitor just wrote has no server id until the history is
// read again; its key is the id the browser gave it, which is also what makes sending twice store once.
export interface ChatMessage {
  key: string
  serverId: string | null
  from: WidgetAuthor
  content: string
  attachments: readonly Attachment[]
  // 0 to 1 while the files of a message of the visitor go up; null when nothing is going up
  progress: number | null
  createdAt: string
  state: WidgetDeliveryState
  // An agent read it: only a message of the visitor can be
  seen: boolean
}
