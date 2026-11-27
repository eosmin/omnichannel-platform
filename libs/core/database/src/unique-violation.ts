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

// A unique violation of ONE index or constraint, by its name: the message of the error names it and so do the details the driver adds to it.
// Any other unique rule of the table is not this one, and a caller that treats "the row exists already" as the answer must not hide it.
export function isUniqueViolationOf(error: unknown, constraint: string): boolean {
  if (!isUniqueViolation(error)) return false
  const message = error instanceof Error ? error.message : ''
  if (message.includes(constraint)) return true
  try {
    // The own fields of the error (the code and the details of the driver) as text
    return JSON.stringify({ ...(error as object) }).includes(constraint)
  } catch {
    // Details that cannot be written as text (a number too big, a loop) name no index we can read: not this one
    return false
  }
}

// Prisma's code for "a foreign key constraint failed": a row that something else points to was deleted (or one that
// points to a row that is gone was written). Same shape check as above.
const FOREIGN_KEY_FAILED = 'P2003'

export function isForeignKeyViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === FOREIGN_KEY_FAILED
  )
}
