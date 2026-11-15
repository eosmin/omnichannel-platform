// The `type` that Express's body parser gives the errors it raises for a body it refuses (http-errors), which the global filter
// reads by shape (`bodyParserRefusal`). The parser of the events route raises the same ones, so the filter answers both alike.
export const BodyParserErrorTypes = {
  TOO_LARGE: 'entity.too.large',
  PARSE_FAILED: 'entity.parse.failed',
  ABORTED: 'request.aborted'
} as const
