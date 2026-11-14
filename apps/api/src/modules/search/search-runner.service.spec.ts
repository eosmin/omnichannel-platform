import { Permissions } from '@platform/core/auth'
import { SearchEntities, SearchTrackedScopes } from '@platform/core/domain'
import { ErrorCodes, HttpStatusCodes, PlatformException } from '@platform/core/errors'

import type { ProductSearchService } from '../products/product-search.service'

import { SearchRunner } from './search-runner.service'
import type { SearchTracker } from './search-tracker.service'
import type { SearchService } from './search.service'

const STORE = '11111111-1111-4111-8111-111111111111'
const VIEWER = {
  userId: '22222222-2222-4222-8222-222222222222',
  held: [Permissions.CUSTOMERS_VIEW]
}

describe('the search runner', () => {
  const track = jest.fn<void, [string, string, string, number, number]>()
  const trackClick = jest.fn()
  const searchCustomers = jest.fn()
  const runner = new SearchRunner(
    { searchCustomers } as unknown as SearchService,
    {} as unknown as ProductSearchService,
    { track, trackClick } as unknown as SearchTracker
  )

  beforeEach(() => {
    track.mockReset()
    trackClick.mockReset()
    searchCustomers.mockReset().mockResolvedValue({ query: 'jose', hits: [], hasMore: false })
  })

  describe('the passive global search', () => {
    it('counts a search that is not passive', async () => {
      await runner.global(STORE, VIEWER, 'jose')
      expect(track).toHaveBeenCalledTimes(1)
      expect(track.mock.calls[0]?.[1]).toBe(SearchTrackedScopes.GLOBAL)
    })

    it('answers a passive search like any other and counts nothing', async () => {
      const result = await runner.global(STORE, VIEWER, 'jose', true)
      expect(searchCustomers).toHaveBeenCalledTimes(1)
      expect(result).toEqual({ query: 'jose', groups: [] })
      expect(track).not.toHaveBeenCalled()
    })

    it('counts the search of one kind even if it comes from the same box', async () => {
      await runner.customers(STORE, { q: 'jose', limit: 25 })
      expect(track).toHaveBeenCalledTimes(1)
    })
  })

  describe('the click on a result', () => {
    const click = {
      q: 'jose',
      scope: SearchTrackedScopes.GLOBAL,
      entity: SearchEntities.CUSTOMERS,
      position: 2
    }

    it('records the click of a kind the member may search, for the store of the request', () => {
      runner.recordClick(STORE, VIEWER.held, click)
      expect(trackClick).toHaveBeenCalledWith(STORE, click, 'jose')
    })

    it('refuses with a 403 and records nothing for a kind the member may not search', () => {
      let error: unknown
      try {
        runner.recordClick(STORE, VIEWER.held, { ...click, entity: SearchEntities.ORDERS })
      } catch (caught) {
        error = caught
      }
      expect(error).toBeInstanceOf(PlatformException)
      expect((error as PlatformException).statusCode).toBe(HttpStatusCodes.FORBIDDEN)
      expect((error as PlatformException).code).toBe(ErrorCodes.PERMISSION_DENIED)
      expect(trackClick).not.toHaveBeenCalled()
    })

    it('needs both permissions of the messages, as their search does', () => {
      const body = { ...click, entity: SearchEntities.MESSAGES }
      expect(() => runner.recordClick(STORE, [Permissions.CONVERSATIONS_VIEW], body)).toThrow(
        PlatformException
      )
      runner.recordClick(STORE, [Permissions.CONVERSATIONS_VIEW, Permissions.MESSAGES_VIEW], body)
      expect(trackClick).toHaveBeenCalledTimes(1)
    })
  })
})
