import { EVENT_LISTENER_METADATA } from '@nestjs/event-emitter'

import { CacheScopes } from '@platform/core/cache'
import { Events } from '@platform/core/events'
import type { CacheService } from '@platform/core/redis'

import { CacheInvalidationListener } from './cache-invalidation.listener'

describe('CacheInvalidationListener', () => {
  const invalidateScope = jest.fn<Promise<void>, [string]>()
  const listener = new CacheInvalidationListener({ invalidateScope } as unknown as CacheService)

  beforeEach(() => {
    invalidateScope.mockReset().mockResolvedValue(undefined)
  })

  it('drops the tags of the store of the event, and only those', async () => {
    await listener.onTagChanged({ storeId: 's1', tagId: 't1' })
    expect(invalidateScope.mock.calls).toEqual([[CacheScopes.storeTags('s1')]])
  })

  it('drops the snippets of the store of the event, and only those', async () => {
    await listener.onSnippetChanged({ storeId: 's1', snippetId: 'n1' })
    expect(invalidateScope.mock.calls).toEqual([[CacheScopes.storeSnippets('s1')]])
  })

  it('drops the preferences of the store of the event, and only those', async () => {
    await listener.onStoreSettingsUpdated({ storeId: 's1' })
    expect(invalidateScope.mock.calls).toEqual([[CacheScopes.storePreferences('s1')]])
  })

  it('throws a failure, so that the event emitter logs it', async () => {
    invalidateScope.mockRejectedValue(new Error('redis is down'))
    await expect(listener.onTagChanged({ storeId: 's1', tagId: 't1' })).rejects.toThrow(
      'redis is down'
    )
  })

  it('listens to every event that changes what is cached', () => {
    // The decorators are stacked: each one adds its event to the metadata of the method
    const eventsOf = (method: keyof CacheInvalidationListener): string[] => {
      const handler: unknown = Object.getOwnPropertyDescriptor(
        CacheInvalidationListener.prototype,
        method
      )?.value
      const entries = (Reflect.getMetadata(EVENT_LISTENER_METADATA, handler as object) ??
        []) as Array<{ event: string }>
      return entries.map(entry => entry.event)
    }
    expect(eventsOf('onTagChanged')).toEqual(
      expect.arrayContaining([Events.TAG_CREATED, Events.TAG_UPDATED, Events.TAG_DELETED])
    )
    expect(eventsOf('onSnippetChanged')).toEqual(
      expect.arrayContaining([
        Events.SNIPPET_CREATED,
        Events.SNIPPET_UPDATED,
        Events.SNIPPET_DELETED
      ])
    )
    expect(eventsOf('onStoreSettingsUpdated')).toEqual([Events.STORE_SETTINGS_UPDATED])
  })
})
