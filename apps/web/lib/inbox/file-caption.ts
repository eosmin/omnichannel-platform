import { CaptionState } from '@platform/core/domain'

// What the thread draws under a file of a message with several: its own text, and how that text went when
// the channel sends it as a message of its own. The first file's text is the text of the message and is drawn
// where it always was, so it is not repeated under the file.
export interface FileCaptionView {
  text: string | null
  state: 'failed' | 'unconfirmed' | 'queued' | null
}

export function fileCaptionOf(
  file: { position: number | null; caption: string | null; captionState: string | null },
  index: number
): FileCaptionView | null {
  // A file of the customer has no place, and the first file's text is the message's
  if (file.position === null || index === 0) return null
  const text = file.caption === null || file.caption.trim() === '' ? null : file.caption
  const state =
    file.captionState === CaptionState.FAILED ||
    file.captionState === CaptionState.UNCONFIRMED ||
    file.captionState === CaptionState.QUEUED
      ? file.captionState
      : null
  return text === null && state === null ? null : { text, state }
}
