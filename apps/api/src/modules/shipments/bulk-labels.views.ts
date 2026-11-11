import type { BulkLabelJobStatus } from '@platform/core/domain'
import type { BulkResultEntry, LabelLeftOut } from '@platform/core/shipping'

// A merged file the person may fetch now: a link that is good for minutes, and the name the file is saved under
export interface FileLinkView {
  url: string
  filename: string
}

// A bulk run of labels (TDD_17 §4.6, §6): how far it is and, order by order, what became of each one. `download` is the file when the
// run made one and it has not been removed by the cleanup; `results` is null until the first order settles.
export interface BulkJobView {
  id: string
  status: BulkLabelJobStatus
  total: number
  succeeded: number
  failed: number
  results: BulkResultEntry[] | null
  download: FileLinkView | null
  createdAt: string
  finishedAt: string | null
}

// "Print labels" of guides that exist: the file, and the guides that are not in it with why (a voided label is never merged)
export interface LabelMergeView {
  download: FileLinkView | null
  merged: string[]
  leftOut: LabelLeftOut[]
  pageCount: number
  // The pages are not all one size: the screen warns before printing
  mixedSizes: boolean
}

export interface BulkJobRow {
  id: string
  status: string
  total: number
  succeeded: number
  failed: number
  results: unknown
  createdAt: Date
  finishedAt: Date | null
}
