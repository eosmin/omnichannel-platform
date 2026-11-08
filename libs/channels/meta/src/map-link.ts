import { MapLinks } from '@platform/core/domain'

// The coordinates a link to a map holds, for a place that Instagram shares as a template with a link (the owner's
// log of 2026-11-08: a `template` whose `generic.elements[]` carry a title, a subtitle, an image and a link).
// Only a link on the exact host of a map (`MapLinks`), over https, with no credentials and the default port.
// Nothing is fetched and no short link is followed: a link with no coordinates in it is no place we can draw.
// Only what names the place counts: the centre of a viewport or of a search (`ll` and `sll`, the `@` of a search page,
// the `#map=` of OpenStreetMap) is not it, and neither is the point 0,0 that an empty value makes.

interface Point {
  lat: number
  long: number
}

const hosts = (list: readonly string[]): ReadonlySet<string> => new Set(list)
const GOOGLE = hosts(MapLinks.GOOGLE_HOSTS)
const APPLE = hosts(MapLinks.APPLE_HOSTS)
const OSM = hosts(MapLinks.OSM_HOSTS)
const REDIRECTS = hosts(MapLinks.REDIRECT_HOSTS)

// More decimals than a place needs are cut (a float written out by an app has 14), never refused
const NUMBER = /^-?\d{1,3}(?:\.\d+)?$/
const COORDINATE = '(-?\\d{1,3}(?:\\.\\d+)?)'

function pointOf(lat: string | undefined, long: string | undefined): Point | null {
  if (lat === undefined || long === undefined || !NUMBER.test(lat) || !NUMBER.test(long)) {
    return null
  }
  const point = { lat: Number(Number(lat).toFixed(7)), long: Number(Number(long).toFixed(7)) }
  if (point.lat === 0 && point.long === 0) return null
  return Math.abs(point.lat) <= 90 && Math.abs(point.long) <= 180 ? point : null
}

function pairOf(text: string | null): Point | null {
  // `loc:13.69,-89.21` is how Google writes a point in a query
  const [lat, long, ...rest] = (text ?? '')
    .replace(/^loc:/, '')
    .split(',')
    .map(part => part.trim())
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
  if (url.hostname !== MapLinks.GOOGLE_MAPS_HOST && !MapLinks.GOOGLE_MAPS_PATH.test(url.pathname)) {
    return null
  }
  // The centre of a PLACE page is the place; that of a search page is a viewport
  if (url.pathname.startsWith(MapLinks.GOOGLE_PLACE_PATH)) {
    // The segment that starts with `@`, or a segment that is the pair itself (`/maps/place/13.69,-89.21`), never an
    // `@` inside the name of the place
    const at = new RegExp(`/@${COORDINATE},${COORDINATE}(?:,|/|$)`).exec(url.pathname)
    const named = new RegExp(
      `^${MapLinks.GOOGLE_PLACE_PATH}${COORDINATE},${COORDINATE}(?:/|$)`
    ).exec(url.pathname)
    const hit = at ?? named
    const point = hit ? pointOf(hit[1], hit[2]) : null
    if (point) return point
  }
  return fromParams(url, MapLinks.GOOGLE_PLACE_PARAMS)
}

function osm(url: URL): Point | null {
  const [lat, long] = MapLinks.OSM_MARKER_PARAMS.map(
    name => url.searchParams.get(name) ?? undefined
  )
  return pointOf(lat, long)
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
