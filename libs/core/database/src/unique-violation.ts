// Prisma's code for "a unique constraint failed". Checked by shape and not with instanceof, so that
// it holds for an error from a transaction, a driver adapter or another copy of the client.
const UNIQUE_CONSTRAINT_FAILED = 'P2002'

export function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === UNIQUE_CONSTRAINT_FAILED
  )
}
