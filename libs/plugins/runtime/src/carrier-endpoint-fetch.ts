import {
  createPinnedFetch,
  type PinnedFetch,
  type PinnedFetchOptions,
  UnsafeUrlError
} from '@platform/core/url-safety'
import { CarrierRejectedError } from '@platform/plugins/sdk'

// The `fetch` that a carrier plugin calls the endpoint of its connection with. The address is typed by the owner of a store, so
// it goes through `createPinnedFetch`: the name is resolved, a name that leads to a non-public address (private, loopback,
// link-local, the metadata address, reserved, multicast) is refused, the connection is made to the address that was checked and
// never to a new answer of the DNS, and a redirect is not followed. A carrier library does not reach `url-safety` (it sees only the
// SDK and the domain), so the runtime builds this and hands it over. An address that is refused is a CarrierRejectedError, the
// refusal of the connection data that the SDK already names.
export function carrierEndpointFetch(
  options: Pick<PinnedFetchOptions, 'timeoutMs' | 'maxResponseBytes' | 'allowCustomPort'> &
    Partial<Pick<PinnedFetchOptions, 'resolve' | 'request'>>
): PinnedFetch {
  const pinned = createPinnedFetch(options)
  return async (url, init) => {
    try {
      return await pinned(url, init)
    } catch (error) {
      if (error instanceof UnsafeUrlError) {
        throw new CarrierRejectedError('The address is not on the public internet')
      }
      throw error
    }
  }
}
