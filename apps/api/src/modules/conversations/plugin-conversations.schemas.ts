import { z } from 'zod'

import { BulkActions, uuidSchema } from '@platform/core/domain'
import { bulkActionSchema, changeStatusSchema } from '@platform/core/messaging'

// What a plugin may ask of the inbox that a person at the screen may ask too, minus what needs a person:
//   - a reply of the closing snippet is written as the person who resolves (the author of a message is a row of `users`);
//   - "assign to me" would give the conversation to the plugin, which is not an assignee anyone can show or reach;
//   - the CSV of a bulk action is a file of the exports center, which belongs to a person (scope `exports:write`, Step 5.6 E7).
export const pluginChangeStatusSchema = changeStatusSchema.refine(
  body => body.closingSnippetId === undefined,
  { message: 'a plugin does not send the closing snippet', path: ['closingSnippetId'] }
)

export const pluginBulkActionSchema = bulkActionSchema.refine(
  body => body.action !== BulkActions.ASSIGN_TO_ME && body.action !== BulkActions.EXPORT_CSV,
  { message: 'a plugin cannot assign to itself or export a file', path: ['action'] }
)

// The handle of the customer on a channel (`customerIdentityId`, as the customer's profile lists them) and the account of the store
// it is written to. Both are read inside the store of the key: the id of a row of another store is a 404.
export const startConversationSchema = z.strictObject({
  customerIdentityId: uuidSchema,
  channelConnectionId: uuidSchema
})

export type StartConversationBody = z.output<typeof startConversationSchema>
export type PluginBulkBody = z.output<typeof pluginBulkActionSchema>
