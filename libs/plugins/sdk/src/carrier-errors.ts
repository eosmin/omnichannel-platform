// The three ways a carrier can fail, so the core never reads provider-specific text

// The carrier refused: bad address, unknown service. The message is safe to show.
export class CarrierRejectedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CarrierRejectedError'
  }
}

// Network, 5xx or a timeout before any answer: the outcome is unknown
export class CarrierUnavailableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CarrierUnavailableError'
  }
}

// The credentials were rejected: the connection goes to ERROR
export class CarrierAuthError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CarrierAuthError'
  }
}
