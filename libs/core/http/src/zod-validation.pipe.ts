import { type PipeTransform } from '@nestjs/common'
import type { z } from 'zod'

import { ErrorCodes, PlatformException } from '@platform/core/errors'

const BAD_REQUEST = 400
// A body full of bad fields must not become a response just as big
const MAX_ISSUES = 20

// Zod at the boundary (CLAUDE.md): @Body(new ZodValidationPipe(schema)). The error names the fields
// and what was wrong with them, never the values that were sent.
export class ZodValidationPipe<T extends z.ZodType> implements PipeTransform<unknown, z.output<T>> {
  constructor(private readonly schema: T) {}

  transform(value: unknown): z.output<T> {
    const result = this.schema.safeParse(value)
    if (result.success) return result.data
    throw new PlatformException(
      ErrorCodes.VALIDATION_FAILED,
      'request validation failed',
      BAD_REQUEST,
      {
        issues: result.error.issues.slice(0, MAX_ISSUES).map(issue => ({
          path: issue.path.join('.'),
          code: issue.code,
          message: issue.message
        })),
        truncated: result.error.issues.length > MAX_ISSUES
      }
    )
  }
}
