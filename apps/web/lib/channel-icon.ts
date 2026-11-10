import {
  Camera,
  Globe,
  Mail,
  type LucideIcon,
  MessageCircle,
  MessageSquare,
  Phone,
  Send,
  Store
} from 'lucide-react'

import { type ChannelIconKey, ChannelIconKeys, isChannelIconKey } from '@platform/core/domain'

// The closed set of icons a plugin can ask for by key. A plugin brings no picture, path or markup: a key that is
// not here is the generic icon.
const ICONS: Record<ChannelIconKey, LucideIcon> = {
  [ChannelIconKeys.MESSAGE_SQUARE]: MessageSquare,
  [ChannelIconKeys.MESSAGE_CIRCLE]: MessageCircle,
  [ChannelIconKeys.PHONE]: Phone,
  [ChannelIconKeys.CAMERA]: Camera,
  [ChannelIconKeys.GLOBE]: Globe,
  [ChannelIconKeys.MAIL]: Mail,
  [ChannelIconKeys.SEND]: Send,
  [ChannelIconKeys.STORE]: Store
}

export function channelIconOf(key: string | null | undefined): LucideIcon {
  return isChannelIconKey(key) ? ICONS[key] : ICONS[ChannelIconKeys.MESSAGE_SQUARE]
}
