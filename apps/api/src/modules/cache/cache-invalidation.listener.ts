import { Injectable } from '@nestjs/common'
import { OnEvent } from '@nestjs/event-emitter'

import { CacheScopes } from '@platform/core/cache'
import { EventContextNotNeeded } from '@platform/core/database'
import { Events, type DomainEventPayloads } from '@platform/core/events'
import { CacheService } from '@platform/core/redis'

// The one place where a change drops what was cached (TDD_08 section 1.3): the services announce what
// they changed with a domain event, after the commit, and never touch the cache to drop it. Every entry
// that CacheService holds names the scopes it depends on, and this listener moves the generation of
// those scopes, so that a read that is loading when the change is made is not stored as current.
//
// Rule: whoever caches a read (getOrSet with `scopes`) adds the events that change it here, and a case
// to the spec of this listener. If the event does not exist yet, it is added to `Events` first.
//
// A failure is thrown, and the event emitter (which suppresses listener errors by default) logs it at error
// level: the change is committed and cannot be undone, and what stays stale is bounded by the TTL of the
// entry. Nothing retries it.
@Injectable()
export class CacheInvalidationListener {
  constructor(private readonly cache: CacheService) {}

  @OnEvent(Events.TAG_CREATED)
  @OnEvent(Events.TAG_UPDATED)
  @OnEvent(Events.TAG_DELETED)
  @EventContextNotNeeded('only drops Redis generations (CacheService), reads no table')
  async onTagChanged(payload: DomainEventPayloads[typeof Events.TAG_CREATED]): Promise<void> {
    await this.cache.invalidateScope(CacheScopes.storeTags(payload.storeId))
  }

  @OnEvent(Events.SNIPPET_CREATED)
  @OnEvent(Events.SNIPPET_UPDATED)
  @OnEvent(Events.SNIPPET_DELETED)
  @EventContextNotNeeded('only drops Redis generations (CacheService), reads no table')
  async onSnippetChanged(
    payload: DomainEventPayloads[typeof Events.SNIPPET_CREATED]
  ): Promise<void> {
    await this.cache.invalidateScope(CacheScopes.storeSnippets(payload.storeId))
  }

  // STORE_SETTINGS_UPDATED is emitted only by PreferencesService (what a store chose in Settings ->
  // Preferences), so it drops only the preferences. The other writers of StoreSettings (inbox, inventory,
  // returns, carriers) emit nothing: a reader of theirs that is cached needs its own event first.
  @OnEvent(Events.STORE_SETTINGS_UPDATED)
  @EventContextNotNeeded('only drops Redis generations (CacheService), reads no table')
  async onStoreSettingsUpdated(
    payload: DomainEventPayloads[typeof Events.STORE_SETTINGS_UPDATED]
  ): Promise<void> {
    await this.cache.invalidateScope(CacheScopes.storePreferences(payload.storeId))
  }
}
