import type { MessageView } from '@platform/api-client'

// The first line of a location card. A place saved before the name and the address were kept apart has
// only the line of text they were joined in, which is the title then; null leaves the card to say
// "shared location".
export function locationTitleOf(
  location: NonNullable<MessageView['location']>,
  content: string | null
): string | null {
  if (location.name !== null) return location.name
  if (location.address !== null) return null
  const line = content?.trim() ?? ''
  return line === '' ? null : line
}
