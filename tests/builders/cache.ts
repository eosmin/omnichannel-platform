import { Redis } from 'ioredis'

import { CacheScopes } from '../../libs/core/platform/cache/cache-keys'
import { CacheService } from '../../libs/core/redis/src/cache.service'
import { REDIS_URL } from '../../libs/core/redis/src/testing/test-env'

// A builder writes as the owner, behind the api's back: no domain event is published, so the listener
// that drops what the api cached never hears of it. A suite that reads the row through the api after
// building it would be served what an earlier read cached (the tag list, the snippet list, the store
// preferences). A builder that writes one of those tables calls this, to do what the listener does.
// Relative imports, not the aliases: the e2e suite of the web app runs these builders too.
export async function dropCachedSettings(
  storeId: string,
  ...which: Array<'tags' | 'snippets' | 'preferences'>
): Promise<void> {
  const redis = new Redis(REDIS_URL)
  try {
    const cache = new CacheService(redis)
    const scopes = {
      tags: CacheScopes.storeTags(storeId),
      snippets: CacheScopes.storeSnippets(storeId),
      preferences: CacheScopes.storePreferences(storeId)
    }
    for (const kind of which) await cache.invalidateScope(scopes[kind])
  } finally {
    await redis.quit()
  }
}
