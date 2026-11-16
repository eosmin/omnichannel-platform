import { InjectQueue } from '@nestjs/bullmq'
import { Injectable } from '@nestjs/common'
import type { Queue } from 'bullmq'

import { fiscalJobOptions } from '@platform/core/domain'
import {
  JobNames,
  QueueNames,
  submitFiscalDocumentJobId,
  type SubmitFiscalDocumentJob
} from '@platform/core/queues'

// The one producer of the submission job: the listener of the sale and the retry route send the same job with the same options. The
// job id is the document and its submission, so a duplicate request while one is waiting is one job, and a corrected document that is
// sent again is another.
@Injectable()
export class FiscalSubmissionQueue {
  constructor(
    @InjectQueue(QueueNames.HEAVY_PROCESSING) private readonly queue: Queue<SubmitFiscalDocumentJob>
  ) {}

  async enqueue(organizationId: string, documentId: string, submission: number): Promise<void> {
    const jobId = submitFiscalDocumentJobId(documentId, submission)
    // A job that failed (its attempts ran out while the authority was down) stays a week: asked again with the same id, the queue would
    // drop the new one in silence. The failed one goes, and the retry of a person runs.
    const earlier = await this.queue.getJob(jobId)
    if (earlier !== undefined && (await earlier.isFailed())) await earlier.remove()
    await this.queue.add(
      JobNames.SUBMIT_FISCAL_DOCUMENT,
      { organizationId, documentId },
      { ...fiscalJobOptions(), jobId }
    )
  }
}
