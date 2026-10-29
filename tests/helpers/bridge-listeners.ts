import { Redis } from 'ioredis'

import { EVENTS_BRIDGE_CHANNEL } from '@platform/core/events'

import { REDIS_URL } from '../../apps/api/src/testing/test-env'

// An api left running (`node dist/apps/api/main.js`) listens to the same bridge channel as the test
// apps, and the instance that claims an event first passes it on: if it is that one, the socket of
// the test never hears it and the suite fails now and then, with no sign of why. Stops the run
// before that, naming what to close. Call it before the first test app is created.
export async function assertNoOtherBridgeListener(): Promise<void> {
  const redis = new Redis(REDIS_URL)
  try {
    const reply = await redis.pubsub('NUMSUB', EVENTS_BRIDGE_CHANNEL)
    const listeners = Number(reply[1])
    if (listeners > 0) {
      throw new Error(
        `${listeners} other process(es) listen to ${EVENTS_BRIDGE_CHANNEL} in this Redis, usually an api left running ` +
          `(dist/apps/api/main.js, nx serve api): they claim the events of the bridge and the sockets of the test never hear them. ` +
          `Close them and run again.`
      )
    }
  } finally {
    redis.disconnect()
  }
}
