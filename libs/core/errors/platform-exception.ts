import type { ErrorCode } from './error-codes'

export class PlatformException extends Error {
  constructor(
    public readonly code: ErrorCode,
    message: string, // English, for logs only
    public readonly statusCode = 500,
    public readonly metadata?: Record<string, unknown>
  ) {
    super(message)
    this.name = 'PlatformException'
  }
}

// Error response contract: it never changes.
export interface ErrorResponse {
  error: {
    code: ErrorCode
    message: string
    metadata: Record<string, unknown>
  }
  correlationId: string
}
