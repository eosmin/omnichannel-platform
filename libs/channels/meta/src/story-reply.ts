import { MessageMetadataKeys, MetaStoryImageHosts } from '@platform/core/domain'

const ALLOWED_HOSTS: readonly string[] = MetaStoryImageHosts

// The link of a story, as the provider gave it, when it can be drawn: https, no credentials, no port, and a host
// that is EXACTLY one of `MetaStoryImageHosts`. Anything else is no link (the card then shows its notice): the
// provider chose the address and the browser would be sent to fetch it.
export function storyImageUrlOf(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return undefined
  }
  const plain = url.protocol === 'https:' && url.username === '' && url.password === ''
  return plain && url.port === '' && ALLOWED_HOSTS.includes(url.hostname) ? raw : undefined
}

// What a reply to a story adds to the metadata of a message: the object says it was a story, the link may
// be missing. Nothing when the message did not answer one.
export function storyReplyMetadata(
  story: { url?: string | undefined } | undefined
): Record<string, { url?: string }> {
  if (!story) return {}
  const url = storyImageUrlOf(story.url)
  return { [MessageMetadataKeys.STORY_REPLY]: url === undefined ? {} : { url } }
}
