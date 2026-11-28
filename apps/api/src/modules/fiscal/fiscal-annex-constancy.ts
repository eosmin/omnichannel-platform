import { FiscalAnnexNotices } from '@platform/core/domain'

// The receipts of the last export of the month against the ones of this one
export function movedSince(
  before: readonly { receiptId: string; sourceSha256: string }[],
  now: readonly { receiptId: string; sha256: string }[]
): Record<string, number> {
  const old = new Map(before.map(item => [item.receiptId, item.sourceSha256]))
  const current = new Map(now.map(item => [item.receiptId, item.sha256]))
  let changed = 0
  let added = 0
  for (const [id, sha] of current) {
    const was = old.get(id)
    if (was === undefined) added += 1
    else if (was !== sha) changed += 1
  }
  let removed = 0
  for (const id of old.keys()) if (!current.has(id)) removed += 1
  const notices: Record<string, number> = { [FiscalAnnexNotices.RE_EXPORT]: 1 }
  if (changed > 0) notices[FiscalAnnexNotices.CHANGED_SINCE_EXPORT] = changed
  if (added > 0) notices[FiscalAnnexNotices.ADDED_SINCE_EXPORT] = added
  if (removed > 0) notices[FiscalAnnexNotices.REMOVED_SINCE_EXPORT] = removed
  return notices
}
