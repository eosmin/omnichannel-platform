import { ErrorCodes } from '@platform/core/errors'

import type { ErrorBody } from './api-schemas'

// An answer that was not a success: the contract of the api (code, message, correlation id), or the
// same shape made up locally when no answer came (the network) or it was not the contract.
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly correlationId: string | null = null,
    readonly metadata: Record<string, unknown> = {}
  ) {
    super(message)
    this.name = 'ApiError'
  }

  static fromBody(status: number, body: ErrorBody): ApiError {
    return new ApiError(
      status,
      body.error.code,
      body.error.message,
      body.correlationId,
      body.error.metadata
    )
  }

  static unreadable(status: number): ApiError {
    return new ApiError(status, ErrorCodes.INTERNAL_ERROR, `Unreadable answer (${status})`)
  }

  is(code: string): boolean {
    return this.code === code
  }
}
