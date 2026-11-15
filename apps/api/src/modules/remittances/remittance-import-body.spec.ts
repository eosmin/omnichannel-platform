import { Readable } from 'node:stream'

import { ErrorCodes } from '@platform/core/errors'

import { isImportContentType, mediaTypeOf, readImportBody } from './remittance-import-body'

const request = (chunks: Buffer[], headers: Record<string, string> = {}) =>
  Object.assign(Readable.from(chunks), { headers })

describe('readImportBody', () => {
  it('reads the text of the body, in as many chunks as it comes', async () => {
    const { text } = await readImportBody(
      request([Buffer.from('Guia,Mo'), Buffer.from('nto\nG-1,5\n')]),
      1024
    )
    expect(text).toBe('Guia,Monto\nG-1,5\n')
  })
  it('reads accents as they were sent', async () => {
    expect((await readImportBody(request([Buffer.from('Guía,Cañón')]), 1024)).text).toBe(
      'Guía,Cañón'
    )
  })
  it('refuses a body larger than the limit while reading it, and by its declared length before', async () => {
    await expect(readImportBody(request([Buffer.alloc(11)]), 10)).rejects.toMatchObject({
      code: ErrorCodes.PAYLOAD_TOO_LARGE
    })
    const declared = request([Buffer.alloc(1)], { 'content-length': '999' })
    await expect(readImportBody(declared, 10)).rejects.toMatchObject({
      code: ErrorCodes.PAYLOAD_TOO_LARGE
    })
  })
  it('refuses bytes that are not UTF-8 instead of reading wrong letters', async () => {
    await expect(
      readImportBody(request([Buffer.from([0xff, 0xfe, 0x41])]), 10)
    ).rejects.toMatchObject({
      code: ErrorCodes.REMITTANCE_IMPORT_INVALID
    })
  })
  it('keeps the bytes that were sent, a BOM included', async () => {
    const sent = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('a,b')])
    const body = await readImportBody(request([sent]), 1024)
    expect(body.bytes.equals(sent)).toBe(true)
    expect(body.text).toBe('a,b')
  })

  it('stops waiting when the client drops the connection before the end', async () => {
    const stream = new Readable({ read: () => undefined })
    const dropped = Object.assign(stream, { headers: {} })
    const reading = readImportBody(dropped, 1024)
    stream.push(Buffer.from('Guia,Mo'))
    stream.destroy()
    await expect(reading).rejects.toMatchObject({ code: ErrorCodes.REMITTANCE_IMPORT_INVALID })
  })

  it('reads the encoding it is told, and refuses bytes that are not that encoding with the code it is given', async () => {
    const latin = Buffer.from('Depósito niño', 'latin1')
    const body = await readImportBody(request([latin]), 1024, {
      encoding: 'windows-1252',
      invalidCode: ErrorCodes.BANK_STATEMENT_INVALID
    })
    expect(body.text).toBe('Depósito niño')
    expect(body.bytes.equals(latin)).toBe(true)
    // the same bytes as UTF-8 are not text, and the refusal carries the code of the bank import
    await expect(
      readImportBody(request([latin]), 1024, { invalidCode: ErrorCodes.BANK_STATEMENT_INVALID })
    ).rejects.toMatchObject({ code: ErrorCodes.BANK_STATEMENT_INVALID })
    // the size limit is the same whatever the encoding
    await expect(
      readImportBody(request([Buffer.alloc(11)]), 10, { encoding: 'windows-1252' })
    ).rejects.toMatchObject({ code: ErrorCodes.PAYLOAD_TOO_LARGE })
  })

  it('reads an empty body as empty text', async () => {
    expect((await readImportBody(request([]), 10)).text).toBe('')
  })
})

describe('the content type of an import', () => {
  it('takes the three text types, with or without parameters and in any case', () => {
    for (const header of [
      'text/csv',
      'TEXT/CSV; charset=utf-8',
      'text/tab-separated-values',
      'text/plain;charset=UTF-8'
    ]) {
      expect(isImportContentType(header)).toBe(true)
    }
    for (const header of [
      undefined,
      '',
      'application/json',
      'application/vnd.ms-excel',
      'text/html'
    ]) {
      expect(isImportContentType(header)).toBe(false)
    }
    expect(mediaTypeOf('text/csv; charset=utf-8')).toBe('text/csv')
  })
})
