import { LocationLinks } from '@platform/core/domain'

const MAX_LATITUDE = 90
const MAX_LONGITUDE = 180
const DECIMALS = 6

const isWithin = (value: unknown, limit: number): value is number =>
  typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= limit

// The link the "open on the map" button points to. It is built from the two numbers and nothing else:
// the name and the address of a place are text of the customer and never reach the link. Coordinates
// that are not numbers in range give no link, so the button is not drawn.
export function mapLinkOf(place: { latitude: number; longitude: number }): string | null {
  if (!isWithin(place.latitude, MAX_LATITUDE) || !isWithin(place.longitude, MAX_LONGITUDE)) {
    return null
  }
  const url = new URL(LocationLinks.MAP_SEARCH_URL)
  url.searchParams.set('api', '1')
  url.searchParams.set(
    'query',
    `${Number(place.latitude.toFixed(DECIMALS))},${Number(place.longitude.toFixed(DECIMALS))}`
  )
  return url.toString()
}
