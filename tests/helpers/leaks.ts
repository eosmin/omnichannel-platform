// A short value (a number, a few letters) searched in a serialized payload with `toContain` also matches inside the
// random uuids and hex ids that the payload is full of, and the test fails now and then by chance (the "4111" of a
// card number inside a uuid). `standalone` matches the value only as a whole token: never glued to hex digits or
// to the hyphens of a uuid, so a uuid cannot hold it, and a real leak ("4111", "card 4111") still does.
export const standalone = (value: string): RegExp =>
  new RegExp(`(?<![0-9a-fA-F-])${value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![0-9a-fA-F-])`)
