import { isRowLevelSecurityError } from '@platform/core/errors'

// No Nest and no database here: the rule is pure so that a spec runs it with nothing around

// Prisma's "record not found" and "foreign key failed": the row was deleted while its delivery was running
const GONE_CODES: ReadonlySet<string> = new Set(['P2025', 'P2003'])

export function isGone(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code
  return typeof code === 'string' && GONE_CODES.has(code)
}

export const GoneVerdict = {
  NOT_GONE: 'not_gone',
  DELETED: 'deleted', // Prisma said so (P2025, P2003): the foreign key failed
  DELETED_BEHIND_POLICY: 'deleted_behind_policy' // The policy of the log refused the row because its parent is gone (SQLSTATE 42501)
} as const
export type GoneVerdict = (typeof GoneVerdict)[keyof typeof GoneVerdict]

// Whether the webhook (or installation) a log row was meant for was deleted while its delivery ran. With row-level security on, the
// policy of the log table checks the parent, so a deleted parent is refused with 42501 before the foreign key can say P2003. A refusal
// by a policy is not enough to say "deleted": a context that does not hold the store is refused the same way, and that is a fault to
// show. So the parent is looked up again, and only its absence is a deletion. `stillThere` must run in a NEW unit of work, because the
// refusal leaves the transaction aborted (25P02), and its own failure keeps the original error (NOT_GONE) instead of replacing it.
export async function judgeGone(
  error: unknown,
  stillThere: () => Promise<boolean>
): Promise<GoneVerdict> {
  if (isGone(error)) return GoneVerdict.DELETED
  if (!isRowLevelSecurityError(error)) return GoneVerdict.NOT_GONE
  try {
    return (await stillThere()) ? GoneVerdict.NOT_GONE : GoneVerdict.DELETED_BEHIND_POLICY
  } catch {
    return GoneVerdict.NOT_GONE
  }
}
