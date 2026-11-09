import { z } from 'zod'

import { MetaSubscription } from './meta-constants'

// What Meta answers for `GET <page>/subscribed_apps`: one entry per app, with the fields that app has on
// the Page. Only `id` and `subscribed_fields` are read (the entry has more, and not always the same:
// the owner's Page answers without `category`).
const ownEntrySchema = z.object({
  id: z.string(),
  subscribed_fields: z.array(z.string()).max(MetaSubscription.MAX_FIELDS).optional()
})
// `paging.next` is present when the answer is not all the apps of the node
const answerSchema = z.object({
  data: z.array(z.unknown()),
  paging: z.object({ next: z.unknown().optional() }).optional()
})
const idOnlySchema = z.object({ id: z.string() })

// The fields our app has on the Page, or null when the answer cannot be trusted as the whole list of them:
// it is not shaped as Meta documents, our entry is, or its fields are not names we can send back, or our
// entry may be on a page of the answer that was not read. The entries of other apps are not read beyond
// their id: they belong to someone else and a badly shaped one must not break this connection. Null
// means nothing is subscribed: posting over a list that could not be read is how another channel's
// fields would be lost.
export function readSubscribedFields(answer: unknown, appId: string): string[] | null {
  const parsed = answerSchema.safeParse(answer)
  if (!parsed.success) return null
  for (const entry of parsed.data.data) {
    const named = idOnlySchema.safeParse(entry)
    if (!named.success || named.data.id !== appId) continue
    const own = ownEntrySchema.safeParse(entry)
    if (!own.success) return null
    const fields = own.data.subscribed_fields ?? []
    return fields.every(name => MetaSubscription.FIELD_NAME_PATTERN.test(name)) ? fields : null
  }
  return parsed.data.paging?.next === undefined ? [] : null
}

// The union of what the app has and what the channel asks for, as the `subscribed_fields` of a POST: what
// the app has first (in the order Meta gave it), then the channel's own, each once. The names the app has
// were checked by `readSubscribedFields`; the filter here is for the list that goes into a URL.
export function mergeSubscribedFields(current: readonly string[], own: string): string {
  const merged: string[] = []
  for (const name of [...current, ...own.split(',')]) {
    if (MetaSubscription.FIELD_NAME_PATTERN.test(name) && !merged.includes(name)) merged.push(name)
  }
  return merged.join(',')
}
