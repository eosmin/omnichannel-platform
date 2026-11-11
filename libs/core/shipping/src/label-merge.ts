import { PDFDocument } from 'pdf-lib'

import { BulkLabelLimits } from '@platform/core/domain'

// A label that is a few pages is a label; a "label" of hundreds is something else
export const MAX_LABEL_PAGES = 20
// Two pages are the same size when they differ by less than a point (a rounding of the renderer, not a size)
const SIZE_TOLERANCE_PT = 1

export interface LabelFile {
  // The shipment the label belongs to
  id: string
  bytes: Uint8Array
}

export interface LabelMergeResult {
  pdf: Uint8Array
  // The shipments whose pages are in the file, in the order of the pages
  merged: string[]
  // The shipments whose file is not a PDF this can read (damaged, locked, or too many pages): left out, never half-copied
  unreadable: string[]
  pageCount: number
  // The pages are not all the same size: the person is warned before printing (TDD_17 §4.6)
  mixedSizes: boolean
}

function sameSize(a: { width: number; height: number }, b: { width: number; height: number }) {
  return (
    Math.abs(a.width - b.width) < SIZE_TOLERANCE_PT &&
    Math.abs(a.height - b.height) < SIZE_TOLERANCE_PT
  )
}

// One PDF from the labels, in the order they are given (the order the agent selected the orders in). A label that cannot be read is
// reported and skipped: one bad file never costs the rest. Pages are copied as they are, so a mixed selection stays mixed.
export async function mergeLabelFiles(files: readonly LabelFile[]): Promise<LabelMergeResult> {
  const output = await PDFDocument.create()
  const merged: string[] = []
  const unreadable: string[] = []
  let first: { width: number; height: number } | undefined
  let mixedSizes = false
  for (const file of files) {
    try {
      // Encrypted files are not opened: a label is not one
      const source = await PDFDocument.load(file.bytes, { updateMetadata: false })
      const count = source.getPageCount()
      if (count < 1 || count > MAX_LABEL_PAGES) {
        unreadable.push(file.id)
        continue
      }
      const pages = await output.copyPages(source, source.getPageIndices())
      // Everything that can fail is done before the first page is added: a label is in the file whole or not at all
      // As the page prints: a page turned a quarter is as wide as it is tall
      const sizes = pages.map(page => {
        const { width, height } = page.getSize()
        const turned = Math.abs(page.getRotation().angle) % 180 === 90
        return turned ? { width: height, height: width } : { width, height }
      })
      for (const page of pages) output.addPage(page)
      for (const size of sizes) {
        first ??= size
        if (!sameSize(first, size)) mixedSizes = true
      }
      merged.push(file.id)
    } catch {
      unreadable.push(file.id)
    }
  }
  // Nothing merged is an empty document, not a blank page the library would add to make a valid file
  const pdf = await output.save({ addDefaultPage: false })
  return { pdf, merged, unreadable, pageCount: output.getPageCount(), mixedSizes }
}

// Whether `size` more bytes still fit in what a merge keeps in memory
export function fitsMergeBudget(usedBytes: number, size: number): boolean {
  return usedBytes + size <= BulkLabelLimits.MAX_MERGE_INPUT_BYTES
}
