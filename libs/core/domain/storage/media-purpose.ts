export const MediaPurpose = {
  MESSAGE: 'message',
  // The picture of the ad a conversation came from
  ORIGIN: 'origin',
  PRODUCT: 'product',
  ORDER: 'order',
  AVATAR: 'avatar',
  EXPORT: 'export',
  SHIPPING_LABEL: 'shipping_label',
  BULK_LABELS: 'bulk_labels',
  REMITTANCE_FILE: 'remittance_file',
  // A receipt or invoice of a transaction of the books, and (4B.4b-2) the bank statement a person imports
  FINANCE_DOCUMENT: 'finance_document',
  // The evidence of a fiscal document (Step 4B.7b-2): the document as it was built, the answer of the authority, the answer to its void.
  // Made by the platform, never uploaded by a person, and never deleted
  FISCAL_EVIDENCE: 'fiscal_evidence'
} as const
export type MediaPurposeType = (typeof MediaPurpose)[keyof typeof MediaPurpose]
