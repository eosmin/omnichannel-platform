import jsQR from 'jsqr'
import { PDFDocument } from 'pdf-lib'

import { FiscalLimits } from '@platform/core/domain'
import type { FiscalRepresentation } from '@platform/fiscal/sdk'

import {
  drawable,
  qrModules,
  RepresentationTooLargeError,
  renderRepresentationPdf
} from './fiscal-representation-pdf'

const URL_OF_CODE =
  'https://admin.factura.gob.sv/consultaPublica?ambiente=01&codGen=1B9D6BCD-BBFD-4B2D-9B5D-AB8DFBBD4BED&fechaEmi=2026-11-16'

const representation = (over: Partial<FiscalRepresentation> = {}): FiscalRepresentation => ({
  title: 'Factura',
  name: 'ABC',
  notices: [],
  sections: [
    { heading: 'Identificación', rows: [{ label: 'Código de Generación', value: 'ABC' }] }
  ],
  table: {
    columns: ['N°', 'Descripción', 'Ventas Gravadas'],
    numericColumns: [0, 2],
    wideColumn: 1,
    rows: [['1', 'Camisa', '22.60']]
  },
  totals: [{ label: 'Total a pagar', value: '28.25' }],
  footnotes: [{ label: 'Valor en letras', value: 'VEINTIOCHO 25/100 DÓLARES' }],
  qrUrl: URL_OF_CODE,
  file: null,
  ...over
})

// Draws the modules the picture draws as an image the way a camera would see them (a quiet zone around, several pixels a module)
function rasterize(modules: boolean[][]): { data: Uint8ClampedArray; size: number } {
  const quiet = 4
  const scale = 6
  const size = (modules.length + quiet * 2) * scale
  const data = new Uint8ClampedArray(size * size * 4).fill(255)
  modules.forEach((row, r) =>
    row.forEach((dark, c) => {
      if (!dark) return
      for (let y = 0; y < scale; y++) {
        for (let x = 0; x < scale; x++) {
          const at = (((r + quiet) * scale + y) * size + (c + quiet) * scale + x) * 4
          data[at] = data[at + 1] = data[at + 2] = 0
        }
      }
    })
  )
  return { data, size }
}

describe('the code of the public consultation', () => {
  it('reads back as exactly the address of the document', () => {
    const { data, size } = rasterize(qrModules(URL_OF_CODE))
    expect(jsQR(data, size, size)?.data).toBe(URL_OF_CODE)
  })

  it('a different address is a different code', () => {
    expect(qrModules(URL_OF_CODE)).not.toEqual(qrModules(`${URL_OF_CODE}x`))
  })
})

describe('the PDF of a representation', () => {
  const at = new Date('2026-11-17T03:30:15.000Z')

  it('is a PDF of a page of the size of a letter', async () => {
    const bytes = await renderRepresentationPdf(representation(), at)
    expect(bytes.subarray(0, 5).toString('latin1')).toBe('%PDF-')
    const loaded = await PDFDocument.load(bytes)
    expect(loaded.getPageCount()).toBe(1)
    expect(loaded.getPage(0).getSize()).toEqual({ width: 612, height: 792 })
  })

  it('is the same file every time for the same model and date', async () => {
    const one = await renderRepresentationPdf(representation(), at)
    const two = await renderRepresentationPdf(representation(), at)
    expect(one.equals(two)).toBe(true)
  })

  it('goes on to another page when the items do not fit, and draws no code when it has no address', async () => {
    const rows = Array.from({ length: 120 }, (_, index) => [String(index + 1), 'Camisa', '1.00'])
    const long = await renderRepresentationPdf(
      representation({
        table: {
          columns: ['N°', 'Descripción', 'Ventas Gravadas'],
          numericColumns: [0, 2],
          wideColumn: 1,
          rows
        }
      }),
      at
    )
    expect((await PDFDocument.load(long)).getPageCount()).toBeGreaterThan(1)
    const plain = await renderRepresentationPdf(representation({ qrUrl: null }), at)
    const withCode = await renderRepresentationPdf(representation(), at)
    expect(plain.byteLength).toBeLessThan(withCode.byteLength)
  })

  it('shows a character the faces cannot draw as a question mark', () => {
    expect(drawable('Camisa 😀 Ñandú')).toBe('Camisa ? Ñandú')
  })

  it('refuses, before drawing, a text or a number of rows above what a document holds', async () => {
    const long = 'x'.repeat(FiscalLimits.REPRESENTATION_MAX_TEXT_CHARS + 1)
    await expect(
      renderRepresentationPdf(
        representation({ footnotes: [{ label: 'Observaciones', value: long }] }),
        at
      )
    ).rejects.toBeInstanceOf(RepresentationTooLargeError)
    const rows = Array.from({ length: FiscalLimits.REPRESENTATION_MAX_ROWS + 1 }, () => [
      '1',
      'a',
      '1'
    ])
    await expect(
      renderRepresentationPdf(
        representation({
          table: { columns: ['N', 'D', 'V'], numericColumns: [0, 2], wideColumn: 1, rows }
        }),
        at
      )
    ).rejects.toBeInstanceOf(RepresentationTooLargeError)
  })
})
