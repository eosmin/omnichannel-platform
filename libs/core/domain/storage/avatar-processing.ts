// What the server does with an avatar: the worker re-encodes what a person uploaded to a square WebP of
// `IMAGE_PIXELS`, which drops the metadata (location, camera), and the api bounds what one person makes it
// do. Apart from `AvatarUpload` so that the browser, which only needs that one, does not carry it.
export const AvatarProcessing = {
  // The side of the square picture that is stored and served
  IMAGE_PIXELS: 256,
  IMAGE_QUALITY: 85,
  // The most pixels the decoder opens for an avatar (a 2 MB file can declare far more than it holds)
  MAX_INPUT_PIXELS: 25_000_000,
  // Avatar rows one person may hold at once (the current picture, the one being replaced, a few
  // uploads not yet attached); the cleanup frees the unattached ones after a day
  MAX_ROWS_PER_USER: 5,
  // The name of the re-encoded file: the name the person gave the upload is not kept
  IMAGE_FILENAME: 'avatar.webp',
  // Signed upload urls one person may ask for per hour. An avatar belongs to the person, not to a
  // store, so it has its own counter and never uses up the quota of a store (`UploadLimits`).
  SIGNED_URLS_PER_USER_PER_HOUR: 20
} as const
