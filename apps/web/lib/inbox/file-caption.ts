import { CaptionState, DeliveryStatus, ResendableCaptionStates } from '@platform/core/domain'

// What the thread draws under a file of a message with several: its own text, and how that text went when
// the channel sends it as a message of its own. The first file's text is the text of the message and is drawn
// where it always was, so it is not repeated under the file.
export interface FileCaptionView {
  text: string | null
  state: 'failed' | 'unconfirmed' | 'queued' | null
}

export function fileCaptionOf(file: {
  position: number | null
  caption: string | null
  captionState: string | null
}): FileCaptionView | null {
  // A file of the customer has no place, and the text of the file at place 0 is the text of the message (the api
  // reads it the same way)
  if (file.position === null || file.position === 0) return null
  const text = file.caption === null || file.caption.trim() === '' ? null : file.caption
  const state =
    file.captionState === CaptionState.FAILED ||
    file.captionState === CaptionState.UNCONFIRMED ||
    file.captionState === CaptionState.QUEUED
      ? file.captionState
      : null
  return text === null && state === null ? null : { text, state }
}

// The file must have gone itself: a text without its file is not what the agent meant (the api refuses it)
const FILE_REACHED_THE_CHANNEL: readonly string[] = [
  DeliveryStatus.SENT,
  DeliveryStatus.DELIVERED,
  DeliveryStatus.READ
]

// A text that may be sent again: it failed (safe) or got no clear answer (the customer may then see it twice,
// so the agent is asked first), and its file went. A text on its way, or one that went, is not offered.
export function mayResendFileCaption(
  state: FileCaptionView['state'],
  fileDelivery: string | null
): state is 'failed' | 'unconfirmed' {
  return (
    state !== null &&
    ResendableCaptionStates.some(allowed => allowed === state) &&
    fileDelivery !== null &&
    FILE_REACHED_THE_CHANNEL.includes(fileDelivery)
  )
}

// Only the text that may already be with the customer asks before it is sent again
export function asksBeforeResending(state: FileCaptionView['state']): boolean {
  return state === CaptionState.UNCONFIRMED
}
