import { UnrecoverableError } from 'bullmq'

// A job whose payload the processor refused on entry (past its queue's size limit, or not the shape of its job type): it will not fit when
// it is tried again, and what it holds is not trusted, so the dead-letter copy keeps no data (`ProcessorSupport.failedAttempt`). The message
// is fixed text: it never names what the job held.
export class JobRejectedError extends UnrecoverableError {}
