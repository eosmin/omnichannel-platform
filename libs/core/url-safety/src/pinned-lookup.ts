import type { RequestOptions } from 'node:https'
import { isIP } from 'node:net'

type Lookup = NonNullable<RequestOptions['lookup']>

// The address the check read, not a new answer of the resolver: whatever name the request is made to,
// the socket is opened to one of these. `all` is honored because the net module asks for it when it
// tries every family.
export function pinnedLookup(addresses: readonly string[]): Lookup {
  const entries = addresses.map(address => ({ address, family: isIP(address) === 6 ? 6 : 4 }))
  return ((_host: string, options: { all?: boolean }, callback: (...args: unknown[]) => void) => {
    const first = entries[0]
    if (first === undefined) {
      callback(new Error('no address to connect to'))
      return
    }
    if (options.all === true) callback(null, entries)
    else callback(null, first.address, first.family)
  }) as unknown as Lookup
}
