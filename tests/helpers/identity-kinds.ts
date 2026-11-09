import {
  ChannelIdentityKinds,
  ChannelIds,
  type ChannelIdentityKindSource
} from '@platform/core/domain'

// What the plugins module provides in the apps, for the specs that build the services by hand: the official
// WhatsApp plugin reads a handle as a phone; any other channel keeps it as it came
export const TEST_IDENTITY_KINDS: ChannelIdentityKindSource = {
  kindOf: channelType =>
    channelType === ChannelIds.WHATSAPP ? ChannelIdentityKinds.PHONE : ChannelIdentityKinds.OPAQUE
}
