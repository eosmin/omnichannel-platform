import { MapLinks } from '@platform/core/domain'

// The coordinates a link to a map holds, for a place that Instagram shares as a template with a link (the owner's
// log of 2026-11-08: a `template` whose `generic.elements[]` carry a title, a subtitle, an image and a link).
// Only a link on the exact host of a map (`MapLinks`), over https, with no credentials and the default port.
// Nothing is fetched and no short link is followed: a link with no coordinates in it is no place we can draw.
// Only what names the place counts: the centre of a viewport or of a search (`sll`, `ll` of Google, the `@` of a
// search page) is not it.

interface Point {
  lat: number
  long: number
}

const hosts = (list: readonly string[]): ReadonlySet<string> => new Set(list)
const GOOGLE = hosts(MapLinks.GOOGLE_HOSTS)
const APPLE = hosts(MapLinks.APPLE_HOSTS)
const OSM = hosts(MapLinks.OSM_HOSTS)
const REDIRECTS = hosts(MapLinks.REDIRECT_HOSTS)

const NUMBER = /^-?\d{1,3}(?:\.\d{1,10})?$/

function pointOf(lat: string | undefined, long: string | undefined): Point | null {
  if (lat === undefined || long === undefined || !NUMBER.test(lat) || !NUMBER.test(long)) {
    return null
  }
  const point = { lat: Number(lat), long: Number(long) }
  return Math.abs(point.lat) <= 90 && Math.abs(point.long) <= 180 ? point : null
}

function pairOf(text: string | null): Point | null {
  const [lat, long, ...rest] = (text ?? '').split(',').map(part => part.trim())
  return rest.length === 0 ? pointOf(lat, long) : null
}

function fromParams(url: URL, names: readonly string[]): Point | null {
  for (const name of names) {
    const point = pairOf(url.searchParams.get(name))
    if (point) return point
  }
  return null
}

function google(url: URL): Point | null {
  // `google.com` is also a search page: only its maps
  if (url.hostname !== 'maps.google.com' && !/^\/maps(?:\/|$)/.test(url.pathname)) return null
  // The centre of a PLACE page is the place; that of a search page is a viewport
  if (url.pathname.startsWith('/maps/place/')) {
    const at = /@(-?\d{1,3}(?:\.\d+)?),(-?\d{1,3}(?:\.\d+)?)/.exec(url.pathname)
    const point = at ? pointOf(at[1], at[2]) : null
    if (point) return point
  }
  return fromParams(url, MapLinks.GOOGLE_PLACE_PARAMS)
}

function osm(url: URL): Point | null {
  const marker = pointOf(
    url.searchParams.get('mlat') ?? undefined,
    url.searchParams.get('mlon') ?? undefined
  )
  if (marker) return marker
  const hash = /^#map=\d{1,2}\/(-?[\d.]+)\/(-?[\d.]+)/.exec(url.hash)
  return hash ? pointOf(hash[1], hash[2]) : null
}

export function coordinatesOfMapLink(link: string, followed = false): Point | null {
  let url: URL
  try {
    url = new URL(link)
  } catch {
    return null
  }
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '' || url.port !== '') {
    return null
  }
  if (REDIRECTS.has(url.hostname)) {
    const target = url.searchParams.get(MapLinks.REDIRECT_PARAM)
    return followed || target === null ? null : coordinatesOfMapLink(target, true)
  }
  if (GOOGLE.has(url.hostname)) return google(url)
  if (APPLE.has(url.hostname)) return fromParams(url, MapLinks.APPLE_PLACE_PARAMS)
  if (OSM.has(url.hostname)) return osm(url)
  return null
}
