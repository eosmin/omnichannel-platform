// The host of a link a customer or a provider sent, shown beside it so that nobody opens a place they
// cannot see. null for anything that is not a plain http(s) link: it is then not drawn as a link.
export function hostOf(link: string): string | null {
  try {
    const url = new URL(link)
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.host : null
  } catch {
    return null
  }
}
