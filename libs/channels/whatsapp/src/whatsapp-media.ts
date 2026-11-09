import { MetaMediaFilesPerMessage } from '@platform/channels/meta'
import {
  type ChannelMediaCapabilities,
  ChannelMediaKinds,
  frozenMedia
} from '@platform/core/channel-media'

import { WhatsAppMediaMaxBytes, WhatsAppMediaTypes } from './whatsapp-constants'

// What the platform declares of the files WhatsApp takes: the two tables above, by kind of file
export const WhatsAppMedia: ChannelMediaCapabilities = frozenMedia({
  maxFilesPerMessage: MetaMediaFilesPerMessage,
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
