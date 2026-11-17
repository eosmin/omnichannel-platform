import { type ArgumentMetadata, type PipeTransform } from '@nestjs/common'

import { containsNul } from '@platform/core/domain'
import { ErrorCodes, HttpStatusCodes, PlatformException } from '@platform/core/errors'

// What a request carries that a person or a program chose: the body, the query and the path
// parameters. A custom decorator (an uploaded file, a header) is not read here.
const READ_KINDS: ReadonlySet<ArgumentMetadata['type']> = new Set(['body', 'query', 'param'])

// Postgres refuses a NUL in text and in jsonb, so one that reaches a query is a 500. The same rule for
// every route and every parameter, whether or not it has a schema of its own: a route with none is
// exactly the one that forgets (QA OPS-RD-046). The error names where, never the value.
export class RejectNulPipe implements PipeTransform<unknown> {
  transform(value: unknown, metadata: ArgumentMetadata): unknown {
    if (READ_KINDS.has(metadata.type) && containsNul(value)) {
      throw new PlatformException(
        ErrorCodes.VALIDATION_FAILED,
        'a NUL character is not allowed',
        HttpStatusCodes.BAD_REQUEST,
        { in: metadata.type, ...(metadata.data === undefined ? {} : { field: metadata.data }) }
      )
    }
    return value
  }
}
