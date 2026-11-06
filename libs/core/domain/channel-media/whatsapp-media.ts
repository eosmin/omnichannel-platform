import { WhatsAppMediaMaxBytes, WhatsAppMediaTypes } from '../whatsapp-constants'

import {
  type ChannelMediaCapabilities,
  ChannelMediaKinds,
  frozenMedia
} from './channel-media-rules'

// What the platform declares of the files WhatsApp takes: the two tables above, by kind of file
export const WhatsAppMedia: ChannelMediaCapabilities = frozenMedia({
  maxFilesPerMessage: 1,
  kinds: {
    [ChannelMediaKinds.IMAGE]: {
      types: WhatsAppMediaTypes.image,
      maxBytes: WhatsAppMediaMaxBytes.image
    },
    [ChannelMediaKinds.VIDEO]: {
      types: WhatsAppMediaTypes.video,
      maxBytes: WhatsAppMediaMaxBytes.video
    },
    [ChannelMediaKinds.AUDIO]: {
      types: WhatsAppMediaTypes.audio,
      maxBytes: WhatsAppMediaMaxBytes.audio
    },
    [ChannelMediaKinds.DOCUMENT]: {
      types: WhatsAppMediaTypes.document,
      maxBytes: WhatsAppMediaMaxBytes.document
    }
  }
})
