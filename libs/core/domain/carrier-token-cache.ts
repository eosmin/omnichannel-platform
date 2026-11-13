// Where a carrier plugin keeps the access token of a connection between calls, so that the api and the worker (and every
// instance of each) share one token and the carrier is asked for a new one only when it expires. The plugin library cannot
// reach Redis (it sees the SDK and the domain only), so the Redis module provides an implementation under this token; a process
// that provides none (a unit test) makes the plugin keep the token in its own memory.
export const CARRIER_TOKEN_CACHE = Symbol('CARRIER_TOKEN_CACHE')

export interface CarrierTokenCache {
  get(storeId: string, connectionId: string): Promise<string | null>
  set(storeId: string, connectionId: string, token: string, ttlSeconds: number): Promise<void>
  delete(storeId: string, connectionId: string): Promise<void>
}

// The cache of a process with no shared store: enough for a test and for a deployment with one instance
export class MemoryCarrierTokenCache implements CarrierTokenCache {
  private readonly entries = new Map<string, { token: string; expiresAt: number }>()

  get(storeId: string, connectionId: string): Promise<string | null> {
    const key = `${storeId}:${connectionId}`
    const entry = this.entries.get(key)
    if (!entry) return Promise.resolve(null)
    if (entry.expiresAt <= Date.now()) {
      this.entries.delete(key)
      return Promise.resolve(null)
    }
    return Promise.resolve(entry.token)
  }

  set(storeId: string, connectionId: string, token: string, ttlSeconds: number): Promise<void> {
    // What expired and was never read again is dropped here, so the map is as big as the connections that are in use
    const now = Date.now()
    for (const [key, entry] of this.entries) if (entry.expiresAt <= now) this.entries.delete(key)
    this.entries.set(`${storeId}:${connectionId}`, {
      token,
      expiresAt: Date.now() + ttlSeconds * 1000
    })
    return Promise.resolve()
  }

  delete(storeId: string, connectionId: string): Promise<void> {
    this.entries.delete(`${storeId}:${connectionId}`)
    return Promise.resolve()
  }
}
