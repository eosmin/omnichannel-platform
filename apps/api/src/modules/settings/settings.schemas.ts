import { z } from 'zod'

import {
  SettingsLimits,
  singleLineText,
  SNIPPET_SHORTCUT_PATTERN,
  TAG_COLOR_PATTERN,
  timezoneSchema,
  uuidSchema,
  weekScheduleSchema
} from '@platform/core/domain'

export const idSchema = uuidSchema

const nothingToChange = { message: 'nothing to change' }
const changesSomething = (body: object): boolean =>
  Object.values(body).some(value => value !== undefined)

// Tags

const tagName = singleLineText(SettingsLimits.TAG_NAME_MAX_LENGTH, 1)
const tagColor = z
  .string()
  .regex(TAG_COLOR_PATTERN)
  .transform(color => color.toLowerCase())
const tagDescription = singleLineText(SettingsLimits.TAG_DESCRIPTION_MAX_LENGTH)

export const createTagSchema = z.strictObject({
  name: tagName,
  color: tagColor.optional(),
  description: tagDescription.optional()
})

export const updateTagSchema = z
  .strictObject({
    name: tagName.optional(),
    color: tagColor.optional(),
    description: tagDescription.nullable().optional()
  })
  .refine(changesSomething, nothingToChange)

// Snippets

// What is typed after the slash, in lowercase: /Gracias and /gracias are one snippet. Lowered before
// it is checked, and ASCII only: another script has letters that look like Latin ones, and two
// shortcuts that look the same are a way to send the wrong text to a customer.
const snippetShortcut = singleLineText(SettingsLimits.SNIPPET_SHORTCUT_MAX_LENGTH, 1)
  .transform(shortcut => shortcut.toLowerCase())
  .pipe(z.string().regex(SNIPPET_SHORTCUT_PATTERN))
const snippetTitle = singleLineText(SettingsLimits.SNIPPET_TITLE_MAX_LENGTH, 1)
// A message is kept as written: the line breaks and the spaces at its end are the agent's. Only a
// text with nothing visible in it is refused.
const snippetContent = z
  .string()
  .max(SettingsLimits.SNIPPET_CONTENT_MAX_LENGTH)
  .refine(value => !value.includes('\0'), { message: 'contains a NUL character' })
  .refine(value => value.trim() !== '', { message: 'is blank' })

export const createSnippetSchema = z.strictObject({
  shortcut: snippetShortcut,
  title: snippetTitle,
  content: snippetContent
})

export const updateSnippetSchema = z
  .strictObject({
    shortcut: snippetShortcut.optional(),
    title: snippetTitle.optional(),
    content: snippetContent.optional()
  })
  .refine(changesSomething, nothingToChange)

// Business hours

export const putBusinessHoursSchema = z.strictObject({
  timezone: timezoneSchema,
  schedule: weekScheduleSchema,
  awayMessageSnippetId: idSchema.nullable()
})

// Inbox behavior (StoreSettings)

const days = z.number().int().min(SettingsLimits.MIN_DAYS).max(SettingsLimits.MAX_DAYS)

export const updateInboxSettingsSchema = z
  .strictObject({
    reopenWindowDays: days.optional(),
    autoArchiveAfterDays: days.optional(),
    resolveShowOptions: z.boolean().optional(),
    sendClosingMessage: z.boolean().optional(),
    closingSnippetId: idSchema.nullable().optional(),
    requestCsat: z.boolean().optional(),
    agentLoadThreshold: z
      .number()
      .int()
      .min(SettingsLimits.MIN_AGENT_LOAD_THRESHOLD)
      .max(SettingsLimits.MAX_AGENT_LOAD_THRESHOLD)
      .optional()
  })
  .refine(changesSomething, nothingToChange)

export type CreateTagBody = z.output<typeof createTagSchema>
export type UpdateTagBody = z.output<typeof updateTagSchema>
export type CreateSnippetBody = z.output<typeof createSnippetSchema>
export type UpdateSnippetBody = z.output<typeof updateSnippetSchema>
export type PutBusinessHoursBody = z.output<typeof putBusinessHoursSchema>
export type UpdateInboxSettingsBody = z.output<typeof updateInboxSettingsSchema>
