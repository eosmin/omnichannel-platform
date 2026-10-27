import { buildChannelPlugin, testChannelFixtures } from '../builders/channel-plugin'

import { testChannelPluginContract } from './channel-plugin.contract'

// The plugin of the suite is the first to pass its own contract; each official plugin adds its
// line beside its code (Steps 2.7 and 2.8)
testChannelPluginContract(() => buildChannelPlugin(), testChannelFixtures)
