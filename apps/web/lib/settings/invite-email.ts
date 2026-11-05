import { z } from 'zod'

// Whether the api would take this address (the same rule it applies, `z.email()`): a browser's own check
// lets through what the api refuses and says so in its own language, so the dialog checks it itself.
// An address with an accent or a ñ before the @ is refused by both.
export function isInvitableEmail(value: string): boolean {
  return z.email().safeParse(value.trim()).success
}
