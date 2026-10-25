import { Logger } from '@nestjs/common'
import type { Redis } from 'ioredis'
import { z } from 'zod'

// Bump it when the shape of what is cached changes in a way a schema cannot read: the old entries
// are then never found and die by their TTL.
const KEY_PREFIX = 'cache:v1:'
const GENERATION_PREFIX = `${KEY_PREFIX}gen:`
// A generation must outlive every entry that carries it. The longest TTL of the platform is a day
// (CacheTTL.VERY_LONG); a generation that expired and started again at 0 could make an old entry
// of generation 0 look current.
const GENERATION_TTL_SECONDS = 7 * 86_400
// Entries written together would expire together: a spread of +-10% staggers the reloads
const TTL_SPREAD = 0.1

// What the cache needs to count hits and misses; the module wires the Prometheus counters
export interface CacheHooks {
  onHit?: (namespace: string) => void
  onMiss?: (namespace: string) => void
}

export interface CacheEntry<T> {
  // A short fixed name for the metrics ("tenant-context"). Never a key or an id: it is a label.
  namespace: string
  // From CacheKeys. Every key that holds tenant data carries the storeId.
  key: string
  ttlSeconds: number
  // What Redis returns is not trusted: it is checked on every read. An entry that does not fit
  // (another version of the code wrote it, or somebody edited it) is a miss.
  schema: z.ZodType<T>
  // Entries of a scope are dropped together with invalidateScope (every cached context of a store when
  // one of its roles changes). An entry can have several: the store, and the member, so that one
  // member or the whole store can be dropped. Whoever invalidates a scope also protects a read that
  // is loading at that moment; deleting a key (del) does not.
  scopes?: readonly string[]
  load: () => Promise<T>
}

// A cache in front of slow or hot reads. It is never the source of truth and it never decides
// alone: when Redis fails the value is loaded from its source, and a failure of the loader is
// passed to the caller and never stored.
//
// A value can be null (the answer "nothing there" is cached too, so that asking for ids that do
// not exist cannot hammer the database) but never undefined, which JSON cannot hold.
export class CacheService {
  private readonly logger = new Logger(CacheService.name)
  // The loads in flight of this process, so that a burst of requests for one key loads it once
  private readonly loading = new Map<string, Promise<unknown>>()

  constructor(
    private readonly redis: Redis,
    private readonly hooks: CacheHooks = {}
  ) {}

  // Every caller gets a copy of its own. Requests that ask together share one load, and the object
  // that comes out of it must not be shared with them: one that changes its copy would change what
  // the others read. (The values are JSON, so the copy is cheap and always possible.)
  async getOrSet<T>(entry: CacheEntry<T>): Promise<T> {
    const inflight = this.loading.get(entry.key)
    if (inflight !== undefined) return structuredClone(await (inflight as Promise<T>)) // Same key, same type
    const loading = this.read(entry).finally(() => this.loading.delete(entry.key))
    this.loading.set(entry.key, loading)
    return structuredClone(await loading)
  }

  // Drops entries by key. A failure is thrown: an entry that should be gone and is not can be a
  // permission that was revoked, so the caller has to know.
  async del(...keys: string[]): Promise<void> {
    if (keys.length === 0) return
    await this.redis.del(...keys.map(key => `${KEY_PREFIX}${key}`))
  }

  // Makes every entry of the scope a miss, without searching for keys
  async invalidateScope(scope: string): Promise<void> {
    const key = `${GENERATION_PREFIX}${scope}`
    await this.redis.multi().incr(key).expire(key, GENERATION_TTL_SECONDS).exec()
  }

  private async read<T>(entry: CacheEntry<T>): Promise<T> {
    const redisKey = `${KEY_PREFIX}${entry.key}`
    // The generations are read before the load: if a scope is invalidated while the load runs, the
    // value is stored under the old generations and the next read treats it as a miss
    let generations: number[] = []
    try {
      const [raw, current] = await this.fetch(redisKey, entry.scopes ?? [])
      generations = current
      const hit = this.parse(raw, entry.schema, generations)
      if (hit.found) {
        this.hooks.onHit?.(entry.namespace)
        return hit.value
      }
    } catch (error) {
      this.logger.warn(`cache read failed, loading from the source: ${describe(error)}`)
    }

    this.hooks.onMiss?.(entry.namespace)
    const value = await entry.load()
    await this.store(redisKey, entry, value, generations)
    return value
  }

  private async fetch(
    redisKey: string,
    scopes: readonly string[]
  ): Promise<[string | null, number[]]> {
    if (scopes.length === 0) return [await this.redis.get(redisKey), []]
    const [raw, ...generations] = await this.redis.mget(
      redisKey,
      ...scopes.map(scope => `${GENERATION_PREFIX}${scope}`)
    )
    return [raw ?? null, generations.map(generation => Number(generation ?? 0))]
  }

  private parse<T>(
    raw: string | null,
    schema: z.ZodType<T>,
    generations: readonly number[]
  ): { found: true; value: T } | { found: false } {
    if (raw === null) return { found: false }
    let json: unknown
    try {
      json = JSON.parse(raw)
    } catch {
      return { found: false }
    }
    const envelope = z.object({ g: z.array(z.number()), v: schema }).safeParse(json)
    if (!envelope.success) return { found: false }
    const { g, v } = envelope.data
    // Same scopes, same generations: an entry written under other ones, or when the generations
    // could not be read, is a miss
    const current = g.length === generations.length && g.every((n, i) => n === generations[i])
    return current ? { found: true, value: v } : { found: false }
  }

  private async store<T>(
    redisKey: string,
    entry: CacheEntry<T>,
    value: T,
    generations: readonly number[]
  ): Promise<void> {
    // A value the schema rejects would be a miss on every read, a silent cost: say so, once, here
    if (!entry.schema.safeParse(value).success) {
      this.logger.error(
        `the value loaded for "${entry.namespace}" does not fit its schema: not cached`
      )
      return
    }
    const spread = 1 + (Math.random() * 2 - 1) * TTL_SPREAD
    const ttl = Math.max(1, Math.round(entry.ttlSeconds * spread))
    try {
      await this.redis.set(redisKey, JSON.stringify({ g: generations, v: value }), 'EX', ttl)
    } catch (error) {
      this.logger.warn(`cache write failed, the value is served anyway: ${describe(error)}`)
    }
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : 'unknown error'
}
