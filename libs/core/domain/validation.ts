import { z } from 'zod'

import { SettingsLimits } from './settings-constants'
import { canonicalTimezone } from './timezone'

export const uuidSchema = z.uuid()

// Control characters (line breaks included) and the invisible format ones (zero-width space, bidi
// overrides) make two names that look the same or draw a name backwards. The joiner U+200D stays: emoji
// are built with it.
const INVISIBLE = /[\p{Cc}\p{Cf}]/u
const JOINER = '‍'

// A name or a title: one visible line, in NFC so that "é" typed two ways is one name. Postgres text
// cannot hold a NUL character: it is a 400 here and not a 500 there.
export function singleLineText(
  maxLength: number,
  minLength = 0
): z.ZodPipe<z.ZodPipe<z.ZodString, z.ZodTransform<string, string>>, z.ZodString> {
  return z
    .string()
    .trim()
    .min(minLength)
    .max(maxLength)
    .transform(value => value.normalize('NFC'))
    .pipe(
      z.string().refine(value => !INVISIBLE.test(value.replaceAll(JOINER, '')), {
        message: 'contains a control or invisible character'
      })
    )
}

// A zone of the IANA database, stored in its canonical spelling
export const timezoneSchema = z
  .string()
  .max(SettingsLimits.TIMEZONE_MAX_LENGTH)
  .transform((value, ctx) => {
    const zone = canonicalTimezone(value)
    if (zone === null) ctx.addIssue({ code: 'custom', message: 'not a timezone' })
    return zone ?? z.NEVER
  })
