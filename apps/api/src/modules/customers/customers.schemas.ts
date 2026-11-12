import { z } from 'zod'

import {
  channelIdSchema,
  CustomerLimits,
  CustomerTimelineTypes,
  LOCALE_TAG_PATTERN,
  MergeableFields,
  MergeFieldSources,
  OrderStatus,
  PaginationLimits,
  singleLineText
} from '@platform/core/domain'
import { normalizePhone } from '@platform/core/messaging'
import { galleryTypeSchema, GalleryTypes, gallerySearchSchema } from '@platform/core/storage'

import { cursorSchema } from './list-cursor'

export const idSchema = z.uuid()

// Postgres text cannot hold a NUL character: it is a 400 here and not a 500 there
const text = () =>
  z
    .string()
    .trim()
    .refine(value => !value.includes('\0'), { message: 'contains a NUL character' })

// One visible line, like the names of tags and snippets: no line break, no invisible or
// direction-changing character, NFC (QA TRX-04)
const name = singleLineText(CustomerLimits.NAME_MAX_LENGTH, 1)
const email = z
  .string()
  .trim()
  .pipe(z.email().max(CustomerLimits.EMAIL_MAX_LENGTH))
  .transform(address => address.toLowerCase())
// A language tag (es, es-SV): letters, and subtags of letters and digits
const locale = z.string().trim().max(CustomerLimits.LOCALE_MAX_LENGTH).regex(LOCALE_TAG_PATTERN)
// The phone always leaves the schema normalized, with its country code
const phone = z
  .string()
  .trim()
  .min(1)
  .transform((text, ctx) => {
    const normalized = normalizePhone(text)
    if (normalized === null) ctx.addIssue({ code: 'custom', message: 'not a valid phone number' })
    return normalized ?? z.NEVER
  })

export const listCustomersQuerySchema = z.strictObject({
  cursor: cursorSchema.optional(),
  limit: z.coerce.number().int().min(1).max(PaginationLimits.MAX).default(PaginationLimits.DEFAULT),
  q: text().min(1).max(CustomerLimits.SEARCH_MAX_LENGTH).optional()
})

// The gallery of a customer (TDD_09 §7): a tab, a search by file name, a page
export const listMediaQuerySchema = z.strictObject({
  cursor: cursorSchema.optional(),
  limit: z.coerce.number().int().min(1).max(PaginationLimits.MAX).default(PaginationLimits.DEFAULT),
  type: galleryTypeSchema.default(GalleryTypes.ALL),
  q: gallerySearchSchema.optional()
})

export const listTimelineQuerySchema = z.strictObject({
  cursor: cursorSchema.optional(),
  limit: z.coerce.number().int().min(1).max(PaginationLimits.MAX).default(PaginationLimits.DEFAULT),
  type: z.enum(Object.values(CustomerTimelineTypes)).optional()
})

export const listCustomerOrdersQuerySchema = z.strictObject({
  cursor: cursorSchema.optional(),
  limit: z.coerce.number().int().min(1).max(PaginationLimits.MAX).default(PaginationLimits.DEFAULT),
  status: z.enum(OrderStatus).optional()
})

export const mergePreviewQuerySchema = z.strictObject({ absorbedId: z.uuid() })

export const createCustomerSchema = z
  .strictObject({
    name: name.optional(),
    email: email.optional(),
    phone: phone.optional(),
    locale: locale.optional()
  })
  .refine(body => body.name !== undefined || body.email !== undefined || body.phone !== undefined, {
    message: 'a customer needs a name, an e-mail address or a phone number'
  })

export const updateCustomerSchema = z
  .strictObject({
    name: name.nullable().optional(),
    email: email.nullable().optional(),
    phone: phone.nullable().optional(),
    locale: locale.nullable().optional()
  })
  .refine(body => Object.values(body).some(value => value !== undefined), {
    message: 'nothing to change'
  })

// The handle is RAW here: `IdentitiesService.link` reads it as its channel says (the plugin declares how), so
// it is the one place that normalizes it
export const linkIdentitySchema = z.strictObject({
  channelType: channelIdSchema,
  channelIdentity: text().min(1).max(CustomerLimits.CHANNEL_IDENTITY_MAX_LENGTH),
  displayName: name.optional()
})

const mergeSource = z.enum([MergeFieldSources.SURVIVOR, MergeFieldSources.ABSORBED])

export const mergeCustomersSchema = z.strictObject({
  absorbedId: z.uuid(),
  fieldChoices: z
    .strictObject(Object.fromEntries(MergeableFields.map(field => [field, mergeSource.optional()])))
    .default({})
})

export const unmergeCustomersSchema = z.strictObject({ mergeId: z.uuid() })

const addressField = text().min(1).max(CustomerLimits.ADDRESS_FIELD_MAX_LENGTH)
const addressBody = {
  label: text().min(1).max(CustomerLimits.ADDRESS_LABEL_MAX_LENGTH),
  line1: addressField,
  line2: addressField,
  city: addressField,
  state: addressField,
  postalCode: text().min(1).max(CustomerLimits.ADDRESS_POSTAL_CODE_MAX_LENGTH),
  // ISO 3166-1 alpha-2
  country: z
    .string()
    .trim()
    .regex(/^[A-Za-z]{2}$/)
    .transform(code => code.toUpperCase()),
  isDefault: z.boolean()
}

export const createAddressSchema = z.strictObject({
  label: addressBody.label.optional(),
  line1: addressBody.line1,
  line2: addressBody.line2.optional(),
  city: addressBody.city,
  state: addressBody.state.optional(),
  postalCode: addressBody.postalCode.optional(),
  country: addressBody.country.optional(),
  isDefault: addressBody.isDefault.optional()
})

export const updateAddressSchema = z
  .strictObject({
    label: addressBody.label.nullable().optional(),
    line1: addressBody.line1.optional(),
    line2: addressBody.line2.nullable().optional(),
    city: addressBody.city.optional(),
    state: addressBody.state.nullable().optional(),
    postalCode: addressBody.postalCode.nullable().optional(),
    country: addressBody.country.optional(),
    isDefault: addressBody.isDefault.optional()
  })
  .refine(body => Object.values(body).some(value => value !== undefined), {
    message: 'nothing to change'
  })

export const createNoteSchema = z.strictObject({
  content: text().min(1).max(CustomerLimits.NOTE_MAX_LENGTH)
})

export const attachTagSchema = z.strictObject({ tagId: z.uuid() })

// The reason is required: a flag nobody can explain is not acted on (TDD_17 §4.16)
export const setCautionSchema = z.strictObject({
  reason: singleLineText(CustomerLimits.CAUTION_REASON_MAX_LENGTH, 1)
})

export type ListTimelineQuery = z.output<typeof listTimelineQuerySchema>
export type ListCustomerOrdersQuery = z.output<typeof listCustomerOrdersQuerySchema>
export type MergePreviewQuery = z.output<typeof mergePreviewQuerySchema>
export type ListMediaQuery = z.output<typeof listMediaQuerySchema>
export type ListCustomersQuery = z.output<typeof listCustomersQuerySchema>
export type CreateCustomerBody = z.output<typeof createCustomerSchema>
export type SetCautionBody = z.output<typeof setCautionSchema>
export type UpdateCustomerBody = z.output<typeof updateCustomerSchema>
export type LinkIdentityBody = z.output<typeof linkIdentitySchema>
export type MergeCustomersBody = z.output<typeof mergeCustomersSchema>
export type UnmergeCustomersBody = z.output<typeof unmergeCustomersSchema>
export type CreateAddressBody = z.output<typeof createAddressSchema>
export type UpdateAddressBody = z.output<typeof updateAddressSchema>
export type CreateNoteBody = z.output<typeof createNoteSchema>
export type AttachTagBody = z.output<typeof attachTagSchema>
