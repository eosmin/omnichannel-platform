import { Prisma } from '../generated/client/client'

// What a write of `null` to a Json column of the schema means: SQL NULL, "no value" (a bare `null` is refused by the
// client because Json could also hold the JSON value null, which no column here uses)
export const DatabaseNull = Prisma.DbNull
