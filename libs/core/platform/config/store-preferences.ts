import { z } from 'zod'

// Imported as '@platform/core/store-preferences', not through the config barrel, which the lint rule
// keeps to the libraries that read the env.
//
// What a store may change without a deploy, kept in StoreSettings.preferences (a Json column).
// This file is the only place of the factory defaults: a key missing from the column reads as the
// default here, so adding a key needs no migration. It holds the keys that exist today; Step 4.14
// grows it into the full schema of TDD_17 §4.14. GET and PUT /settings/preferences (Step 3.6) are built
// over it and take the new keys as they are added.
//
// Each key falls back to its own default (`catch`): a value that does not fit in one key must not reset
// the others, least of all a switch the store turned off.
export const storePreferencesSchema = z.object({
  // A store may read a conversation without telling the customer (blue ticks); on by default
  sendReadReceipts: z.boolean().catch(true),
  // The first reply of an agent who may assign, to a conversation nobody has, gives it to them; on by
  // default, in the stores that already exist too (a key that is missing reads as this)
  assignOnReply: z.boolean().catch(true)
})

export type StorePreferences = z.output<typeof storePreferencesSchema>

// The column is written by the api, but a value that does not fit (edited by hand, or left by an older
// version) reads as the defaults rather than failing the request that asked
export function readStorePreferences(raw: unknown): StorePreferences {
  const parsed = storePreferencesSchema.safeParse(raw)
  return parsed.success ? parsed.data : storePreferencesSchema.parse({})
}

// What PUT /settings/preferences takes: the keys the caller changes, each held to its real type (the
// `catch` above is for reading what is stored, never for accepting what a client sends). Keys that are
// not named keep their value, so a page that draws only some of them cannot reset the others.
export const updateStorePreferencesSchema = z
  .strictObject({
    sendReadReceipts: z.boolean().optional(),
    assignOnReply: z.boolean().optional()
  })
  .refine(body => Object.values(body).some(value => value !== undefined), {
    message: 'nothing to change'
  })

export type UpdateStorePreferencesBody = z.output<typeof updateStorePreferencesSchema>
