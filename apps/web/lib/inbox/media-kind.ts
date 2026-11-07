import { MessageType } from '@platform/core/domain'
import { mediaMessageTypeOf, type OutboundMediaType } from '@platform/core/storage'

// How a file of a message is drawn. It follows the type of the file, except for one case: a voice note of
// Instagram is an mp4 (an audio in the container of a video), so a file that reads as a video inside a
// message the channel said is AUDIO is drawn by the audio player. Only that case: a message can carry files
// of several kinds (an album that starts with a picture and has a video), and each is drawn as what it is.
export function mediaKindOf(messageType: string, contentType: string): OutboundMediaType | null {
  const kind = mediaMessageTypeOf(contentType)
  return messageType === String(MessageType.AUDIO) && kind === MessageType.VIDEO
    ? MessageType.AUDIO
    : kind
}
