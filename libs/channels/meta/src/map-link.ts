// The coordinates a link to a map holds, for a place that Instagram shares as a template with a link (the owner's
// log of 2026-11-08: a `template` whose `generic.elements[]` carry a title, a subtitle, an image and a link).
// Only a link on the exact host of a map, over https, with no credentials and the default port. Nothing is fetched
// and no short link is followed: a link with no coordinates in it is no place we can draw.

const GOOGLE = new Set(['www.google.com', 'google.com', 'maps.google.com'])
const APPLE = new Set(['maps.apple.com'])
const OSM = new Set(['www.openstreetmap.org', 'openstreetmap.org'])
// The links Instagram and Facebook put in front of an outside link; followed once, and only to a map
const REDIRECTS = new Set(['l.instagram.com', 'l.facebook.com', 'lm.facebook.com'])

interface Point {
  lat: number
  long: number
}

const NUMBER = /^-?\d{1,3}(?:\.\d{1,10})?$/

function pointOf(lat: string | undefined, long: string | undefined): Point | null {
  if (lat === undefined || long === undefined || !NUMBER.test(lat) || !NUMBER.test(long))
    return null
  const point = { lat: Number(lat), long: Number(long) }
  return Math.abs(point.lat) <= 90 && Math.abs(point.long) <= 180 ? point : null
}

function pairOf(text: string | null): Point | null {
  const [lat, long, ...rest] = (text ?? '').split(',').map(part => part.trim())
  return rest.length === 0 ? pointOf(lat, long) : null
}

function google(url: URL): Point | null {
  // `google.com` is also a search page: only its maps
  if (url.hostname !== 'maps.google.com' && !url.pathname.startsWith('/maps')) return null
  const at = /@(-?\d{1,3}(?:\.\d+)?),(-?\d{1,3}(?:\.\d+)?)/.exec(url.pathname)
  if (at) return pointOf(at[1], at[2])
  for (const name of ['query', 'q', 'll', 'destination']) {
    const point = pairOf(url.searchParams.get(name))
    if (point) return point
  }
  return null
}

function apple(url: URL): Point | null {
  for (const name of ['ll', 'coordinate', 'sll']) {
    const point = pairOf(url.searchParams.get(name))
    if (point) return point
  }
  return null
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
    const target = url.searchParams.get('u')
    return followed || target === null ? null : coordinatesOfMapLink(target, true)
  }
  if (GOOGLE.has(url.hostname)) return google(url)
  if (APPLE.has(url.hostname)) return apple(url)
  if (OSM.has(url.hostname)) return osm(url)
  return null
}
