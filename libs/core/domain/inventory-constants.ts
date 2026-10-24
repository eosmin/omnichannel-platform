import { CountStatus, TransferStatus } from './status-enums'

// Enforced inside the owning service (TDD_16 §3). RECEIVED and CANCELLED are terminal.
export const TransferStatusTransitions: Record<TransferStatus, readonly TransferStatus[]> = {
  [TransferStatus.DRAFT]: [TransferStatus.IN_TRANSIT, TransferStatus.CANCELLED],
  [TransferStatus.IN_TRANSIT]: [TransferStatus.RECEIVED, TransferStatus.CANCELLED],
  [TransferStatus.RECEIVED]: [],
  [TransferStatus.CANCELLED]: []
}

// A count can go back from REVIEW to COUNTING. APPLIED and CANCELLED are terminal.
export const CountStatusTransitions: Record<CountStatus, readonly CountStatus[]> = {
  [CountStatus.DRAFT]: [CountStatus.COUNTING, CountStatus.CANCELLED],
  [CountStatus.COUNTING]: [CountStatus.REVIEW, CountStatus.CANCELLED],
  [CountStatus.REVIEW]: [CountStatus.COUNTING, CountStatus.APPLIED, CountStatus.CANCELLED],
  [CountStatus.APPLIED]: [],
  [CountStatus.CANCELLED]: []
}
