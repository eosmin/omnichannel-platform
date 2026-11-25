import { Prisma } from '../generated/client/client'

// What a write of `null` to a Json column of the schema means: SQL NULL, "no value" (a bare `null` is refused by the
// client because Json could also hold the JSON value null, which no column here uses)
export const DatabaseNull = Prisma.DbNull

// A filter that matches a column that is SQL NULL AND one that holds the JSON value null: for the guard of a write on a row that was
// READ as `null`, which the client answers for both
export const AnyDatabaseNull = Prisma.AnyNull

// The JSON value null (no column of the schema is meant to hold it; a spec writes one to see how a filter treats it)
export const JsonValueNull = Prisma.JsonNull
