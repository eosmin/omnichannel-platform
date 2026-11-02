import type { Job } from 'bullmq'

// Cleanup only: a worker of another process may hold the job for a moment, and removing a locked
// job throws. The case has already asserted what it came for, so the lock is not its failure.
export async function dropJob(job: Job | undefined): Promise<void> {
  try {
    await job?.remove()
  } catch (error) {
    if (!(error instanceof Error) || !error.message.includes('locked by another worker'))
      throw error
  }
}
