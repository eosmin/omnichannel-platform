// Errors of the machine, not of the file: a retry may well work, so they must not end in a refusal. Its own module because the thread that
// cleans documents needs it and must not load the image decoder (a native binary) to get it
const ENVIRONMENT_ERROR = /memory|ENOMEM|resource|thread|too many open|EMFILE|cannot allocate/i

// Whether an error is of the machine and not of the file (see ENVIRONMENT_ERROR): a retry may work, so it must never end as a refusal
export const isEnvironmentError = (error: unknown): boolean =>
  error instanceof Error && ENVIRONMENT_ERROR.test(error.message)
