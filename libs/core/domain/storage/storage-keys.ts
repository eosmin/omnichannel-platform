import { AvatarProcessing } from './avatar-processing'

export const ImageVariants = { FULL: 'full', MEDIUM: 'medium', THUMB: 'thumb' } as const
export type ImageVariant = (typeof ImageVariants)[keyof typeof ImageVariants]

export const MediaObjectAreas = { UPLOADS: 'uploads', MESSAGES: 'messages' } as const
export type MediaObjectArea = (typeof MediaObjectAreas)[keyof typeof MediaObjectAreas]

// Where every key of the stores begins
export const STORES_ROOT = 'stores/'

const MEDIA_OBJECT_KEY = new RegExp(
  `^${STORES_ROOT}[^/]+/(${Object.values(MediaObjectAreas).join('|')})/([^/]+)/.+$`
)

// The inverse of `StorageKeys.message` and `messageUpload` (and of the variants, which sit under the
// media id of their original): which area a key is in and which media it belongs to. null for any
// other key of the bucket.
export function parseMediaObjectKey(
  key: string
): { area: MediaObjectArea; mediaId: string } | null {
  const match = MEDIA_OBJECT_KEY.exec(key)
  const area = match?.[1]
  const mediaId = match?.[2]
  if (mediaId === undefined) return null
  return area === MediaObjectAreas.UPLOADS || area === MediaObjectAreas.MESSAGES
    ? { area, mediaId }
    : null
}

// Where every key of a user's own files begins (an avatar has no store)
export const USERS_ROOT = 'users/'

// The inverse of `StorageKeys.avatarUpload`: the user and the media a staging object of an avatar is
// for, or null for any other key
const AVATAR_UPLOAD_KEY = new RegExp(`^${USERS_ROOT}([^/]+)/avatar-uploads/([^/]+)/.+$`)
export function parseAvatarUploadKey(key: string): { userId: string; mediaId: string } | null {
  const match = AVATAR_UPLOAD_KEY.exec(key)
  const userId = match?.[1]
  const mediaId = match?.[2]
  return userId === undefined || mediaId === undefined ? null : { userId, mediaId }
}

// The inverse of `StorageKeys.avatar`: the media a final avatar file belongs to, or null
const AVATAR_KEY = new RegExp(`^${USERS_ROOT}([^/]+)/avatar/([^/]+)/.+$`)
export function parseAvatarKey(key: string): { userId: string; mediaId: string } | null {
  const match = AVATAR_KEY.exec(key)
  const userId = match?.[1]
  const mediaId = match?.[2]
  return userId === undefined || mediaId === undefined ? null : { userId, mediaId }
}

// The ONLY place S3 keys are built (TDD_01 §2.3).
export const StorageKeys = {
  message: (storeId: string, mediaId: string, filename: string) =>
    `${STORES_ROOT}${storeId}/${MediaObjectAreas.MESSAGES}/${mediaId}/${filename}`,
  // Where a client PUTs a file for a message. Confirming copies it to `message(...)`: the signed URL
  // stays valid for its TTL after the confirmation, so the object a client can still overwrite is
  // never the one that is scanned and served.
  messageUpload: (storeId: string, mediaId: string, filename: string) =>
    `${STORES_ROOT}${storeId}/${MediaObjectAreas.UPLOADS}/${mediaId}/${filename}`,
  // Everything under one upload id, to find the file of an upload whose name only the api knew
  messageUploadPrefix: (storeId: string, mediaId: string) =>
    `${STORES_ROOT}${storeId}/${MediaObjectAreas.UPLOADS}/${mediaId}/`,
  messageVariant: (storeId: string, mediaId: string, variant: ImageVariant) =>
    `${STORES_ROOT}${storeId}/${MediaObjectAreas.MESSAGES}/${mediaId}/variants/${variant}.webp`,
  product: (storeId: string, productId: string, mediaId: string, filename: string) =>
    `stores/${storeId}/products/${productId}/${mediaId}/${filename}`,
  order: (storeId: string, orderId: string, mediaId: string, filename: string) =>
    `stores/${storeId}/orders/${orderId}/${mediaId}/${filename}`,
  export: (storeId: string, exportId: string, filename: string) =>
    `stores/${storeId}/exports/${exportId}/${filename}`,
  exportPrefix: (storeId: string, exportId: string) => `stores/${storeId}/exports/${exportId}/`,
  avatar: (userId: string, mediaId: string, filename: string) =>
    `${USERS_ROOT}${userId}/avatar/${mediaId}/${filename}`,
  // Where a client PUTs an avatar. Confirming copies it to `avatar(...)`, as for a message file: what is
  // scanned and served is never writable by the uploader.
  avatarUpload: (userId: string, mediaId: string, filename: string) =>
    `${USERS_ROOT}${userId}/avatar-uploads/${mediaId}/${filename}`,
  // The re-encoded picture the worker writes from a confirmed avatar: the only file of an avatar that is
  // served. It sits under the media id of the original, in a folder of its own: a name the person gave the upload
  // (sanitized, so never with a slash) can never be the same key.
  avatarImage: (userId: string, mediaId: string) =>
    `${USERS_ROOT}${userId}/avatar/${mediaId}/processed/${AvatarProcessing.IMAGE_FILENAME}`,
  // Everything that belongs to one user: a key outside it is another user's, whatever the store
  userPrefix: (userId: string) => `${USERS_ROOT}${userId}/`,
  dsrExport: (requestId: string) => `compliance/dsr/${requestId}/export.zip`,
  auditArchive: (year: number, month: number) =>
    `audit/${year}/${String(month).padStart(2, '0')}/audit-logs.jsonl.gz`,
  storePrefix: (storeId: string) => `stores/${storeId}/`
} as const
