import { degrees, PDFDocument } from 'pdf-lib'

import { BulkLabelLimits } from '@platform/core/domain'

import { fitsMergeBudget, MAX_LABEL_PAGES, mergeLabelFiles } from './label-merge'

// A PDF of pages of the given sizes: the size of each page is what tells, afterwards, in which order they were merged
async function pdfOf(...sizes: [number, number][]): Promise<Uint8Array> {
  const doc = await PDFDocument.create()
  for (const size of sizes) doc.addPage(size)
  return doc.save()
}

async function sizesOf(bytes: Uint8Array): Promise<[number, number][]> {
  const doc = await PDFDocument.load(bytes)
  return doc.getPages().map(page => [Math.round(page.getWidth()), Math.round(page.getHeight())])
}

describe('mergeLabelFiles', () => {
  it('puts the pages in the order of the files, whatever their sizes', async () => {
    const result = await mergeLabelFiles([
      { id: 'a', bytes: await pdfOf([288, 432]) },
      { id: 'b', bytes: await pdfOf([100, 100], [110, 110]) },
      { id: 'c', bytes: await pdfOf([300, 300]) }
    ])
    expect(result.merged).toEqual(['a', 'b', 'c'])
    expect(result.unreadable).toEqual([])
    expect(result.pageCount).toBe(4)
    expect(await sizesOf(result.pdf)).toEqual([
      [288, 432],
      [100, 100],
      [110, 110],
      [300, 300]
    ])
  })

  it('warns when the pages are not all one size, and not when they are', async () => {
    const mixed = await mergeLabelFiles([
      { id: 'a', bytes: await pdfOf([288, 432]) },
      { id: 'b', bytes: await pdfOf([595, 842]) }
    ])
    expect(mixed.mixedSizes).toBe(true)
    const same = await mergeLabelFiles([
      { id: 'a', bytes: await pdfOf([288, 432]) },
      { id: 'b', bytes: await pdfOf([288.4, 431.7]) }
    ])
    expect(same.mixedSizes).toBe(false)
  })

  it('reads the size of a page as it prints, so a turned label is not a different size', async () => {
    const turned = await PDFDocument.create()
    turned.addPage([432, 288]).setRotation(degrees(90))
    const result = await mergeLabelFiles([
      { id: 'a', bytes: await pdfOf([288, 432]) },
      { id: 'b', bytes: await turned.save() }
    ])
    expect(result.merged).toEqual(['a', 'b'])
    expect(result.mixedSizes).toBe(false)
  })

  it('leaves out and reports a file that is not a PDF, and keeps the rest in order', async () => {
    const result = await mergeLabelFiles([
      { id: 'a', bytes: await pdfOf([288, 432]) },
      { id: 'broken', bytes: new TextEncoder().encode('%PDF-1.4 this is not a document') },
      { id: 'empty', bytes: new Uint8Array() },
      { id: 'c', bytes: await pdfOf([300, 300]) }
    ])
    expect(result.merged).toEqual(['a', 'c'])
    expect(result.unreadable).toEqual(['broken', 'empty'])
    expect(await sizesOf(result.pdf)).toEqual([
      [288, 432],
      [300, 300]
    ])
  })

  it('refuses a "label" of more pages than a label has, whole and not in part', async () => {
    const many = await pdfOf(
      ...Array.from({ length: MAX_LABEL_PAGES + 1 }, (): [number, number] => [50, 50])
    )
    const result = await mergeLabelFiles([
      { id: 'many', bytes: many },
      { id: 'ok', bytes: await pdfOf([50, 50]) }
    ])
    expect(result.unreadable).toEqual(['many'])
    expect(result.merged).toEqual(['ok'])
    expect(result.pageCount).toBe(1)
  })

  it('makes an empty document of nothing', async () => {
    const result = await mergeLabelFiles([])
    expect(result.merged).toEqual([])
    expect(result.pageCount).toBe(0)
    expect(result.mixedSizes).toBe(false)
  })
})

describe('fitsMergeBudget', () => {
  it('takes a file while the total stays within what a merge keeps', () => {
    expect(fitsMergeBudget(0, BulkLabelLimits.MAX_MERGE_INPUT_BYTES)).toBe(true)
    expect(fitsMergeBudget(BulkLabelLimits.MAX_MERGE_INPUT_BYTES - 10, 10)).toBe(true)
    expect(fitsMergeBudget(BulkLabelLimits.MAX_MERGE_INPUT_BYTES - 10, 11)).toBe(false)
  })
})
