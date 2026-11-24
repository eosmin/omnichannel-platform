// The `type` that Express's body parser gives the errors it raises for a body it refuses (http-errors), which the global filter
// reads by shape (`bodyParserRefusal`). The parser of the events route raises the same ones, so the filter answers both alike.
export const BodyParserErrorTypes = {
  TOO_LARGE: 'entity.too.large',
  PARSE_FAILED: 'entity.parse.failed',
  ABORTED: 'request.aborted',
  // A compressed body (gzip, deflate, br, zstd) that cannot be inflated: empty, cut short or not what its encoding says. The parser
  // passes on the raw error of the decompressor, which has no `type` of its own; the filter gives it this one.
  CORRUPT_ENCODING: 'encoding.corrupt'
} as const
