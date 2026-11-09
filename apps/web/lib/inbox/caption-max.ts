// The most characters the text under a file takes on a channel: the caption rule its plugin declared where it has
// one, else the limit of its text. Undefined while the directory has not said (the api checks it anyway).
export function captionMaxOf(
  limits: { textMaxLength: number; caption: { maxLength: number } | null } | null | undefined
): number | undefined {
  if (limits === null || limits === undefined) return undefined
  return limits.caption?.maxLength ?? limits.textMaxLength
}
