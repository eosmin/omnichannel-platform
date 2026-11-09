import type { z } from 'zod'

// zod drops every key a schema does not name, so a field added to a job type and not to its schema is
// lost between Redis and the worker without an error (a reaction under one file of an album once
// arrived with no `mediaId`). `exactly` makes that a compile error: the schema's output and the job
// type must have the same keys (assignability alone would let an optional key slip out) and be
// assignable to each other.
type Same<Schema, Job> = [keyof Schema] extends [keyof Job]
  ? [keyof Job] extends [keyof Schema]
    ? [Schema] extends [Job]
      ? [Job] extends [Schema]
        ? unknown
        : never
      : never
    : never
  : never

export const exactly = <Job>(): (<
  Schema extends z.ZodType & { _output: Same<z.output<Schema>, Job> }
>(
  schema: Schema
) => Schema) => {
  return schema => schema
}
