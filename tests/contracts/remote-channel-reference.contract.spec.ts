import { startReferencePlugin } from './remote-channel-reference-plugin'
import { testReferenceEventsContract, testRemoteChannelContract } from './remote-channel.contract'

// The reference plugin is the first to pass its own contract (TDD_10 §6.7.9); a plugin author runs the same suite with a service
// of their own in place of `startReferencePlugin`
testRemoteChannelContract(clock => startReferencePlugin(['secret-one'], { now: () => clock.nowMs }))
testReferenceEventsContract()
