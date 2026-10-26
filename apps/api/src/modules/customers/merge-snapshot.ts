import { z } from 'zod'

// The fields of a customer that a merge can change. Dates travel as ISO strings: the snapshot is JSON.
export const MERGED_FIELDS = [
  'name',
  'email',
  'phone',
  'phoneNormalized',
  'locale',
  'isCaution',
  'cautionReason',
  'cautionSetBy',
  'cautionSetAt'
] as const
export type MergedField = (typeof MERGED_FIELDS)[number]

const fieldValue = z.union([z.string(), z.boolean(), z.null()])
const fieldValues = z.record(z.string(), fieldValue)
const idList = z.array(z.uuid())

// What a merge wrote and what it moved, enough to undo it (TDD_01 §4, CustomerMerge.snapshot; the
// before/after values and the media are added by this implementation, MVP_TRIM_CHECKLIST.md).
export const mergeSnapshotSchema = z.object({
  // The survivor's fields before the merge and after it: an unmerge puts back only the ones that
  // still hold what the merge wrote, so an edit made in between is not lost
  survivorBefore: fieldValues,
  survivorAfter: fieldValues,
  survivorTagIdsBefore: idList,
  absorbedTagIds: idList,
  identityIds: idList,
  conversationIds: idList,
  orderIds: idList,
  addressIds: idList,
  // Addresses that were the default of the absorbed customer and stopped being it
  defaultedAddressIds: idList,
  noteIds: idList,
  mediaIds: idList,
  // Consent history is proof about the person: it follows them, so the cleanup that deletes the
  // absorbed row cannot take it along (ConsentRecord goes with its customer)
  consentIds: idList.default([]),
  fieldChoices: z.record(z.string(), z.string())
})

export type MergeSnapshot = z.infer<typeof mergeSnapshotSchema>
