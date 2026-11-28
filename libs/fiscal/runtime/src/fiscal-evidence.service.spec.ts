import type { PinoLogger } from 'nestjs-pino'

import type { CredentialCipher } from '@platform/core/crypto'
import {
  FiscalConflictReasons,
  FiscalDocumentStatus,
  FiscalEvidenceKind,
  FiscalLimits
} from '@platform/core/domain'
import type { FiscalDocumentProvider, FiscalRepresentation } from '@platform/fiscal/sdk'

import { FiscalEvidenceService } from './fiscal-evidence.service'
import type { FiscalProviderRegistry } from './fiscal-provider.registry'

// The decorator of the queue comes from a package that is ESM only; the spec injects the queue by hand
jest.mock('@nestjs/bullmq', () => ({ InjectQueue: () => () => undefined }))
const EVENT = { identificacion: { codigoGeneracion: 'EVT' } }
jest.mock('./sealed-open', () => ({
  openSealed: jest.fn((_cipher: unknown, _logger: unknown, _sealed: unknown, what: string) =>
    what === 'void-event'
      ? { event: EVENT, signature: 'JWS' }
      : { identificacion: { codigoGeneracion: 'ABC' } }
  )
}))

const representation: FiscalRepresentation = {
  title: 'Factura',
  name: 'ABC',
  notices: [],
  sections: [{ heading: 'Identificación', rows: [{ label: 'Código', value: 'ABC' }] }],
  table: null,
  totals: [],
  footnotes: [],
  qrUrl: 'https://example.test/consult?x=1',
  file: {
    filename: 'ABC.json',
    content: { identificacion: { codigoGeneracion: 'ABC' }, selloRecibido: 'S' }
  }
}

const row = {
  id: 'doc-1',
  storeId: 'store-1',
  status: FiscalDocumentStatus.ACCEPTED,
  sequenceNumber: 7,
  documentType: '01',
  providerId: 'p',
  externalNumber: 'EXT',
  providerData: { receptionSeal: 'S' },
  builtPayloadEncrypted: new Uint8Array([1]),
  response: null,
  voidReason: null,
  voidedAt: null,
  voidResponse: null,
  voidEventEncrypted: null as Uint8Array | null,
  issuedAt: new Date('2026-11-17T03:30:15.000Z'),
  createdAt: new Date('2026-11-17T03:30:00.000Z')
}

function build(
  provider: Partial<FiscalDocumentProvider> | undefined,
  over: { status?: FiscalDocumentStatus; existing?: unknown; row?: Record<string, unknown> } = {}
) {
  const put = jest.fn().mockResolvedValue(undefined)
  const create = jest.fn().mockResolvedValue({})
  const client = {
    fiscalDocument: {
      findFirst: jest
        .fn()
        .mockResolvedValue({ ...row, status: over.status ?? row.status, ...over.row })
    },
    media: { findFirst: jest.fn().mockResolvedValue(over.existing ?? null), create }
  }
  const prisma = { client, afterCommitStep: (_c: unknown, work: () => Promise<void>) => work() }
  const logger = { setContext: jest.fn(), error: jest.fn(), warn: jest.fn() }
  const service = new FiscalEvidenceService(
    prisma as never,
    {} as CredentialCipher,
    { put, delete: jest.fn(), head: jest.fn() } as never,
    { getJob: jest.fn(), add: jest.fn() } as never,
    logger as unknown as PinoLogger,
    { inOrganizationOrRequest: (_o: string, work: () => unknown) => work() } as never,
    { find: () => provider } as unknown as FiscalProviderRegistry
  )
  return { service, put, create, logger }
}

describe('the files the receiver is given', () => {
  it('keeps the file of the document as the provider defines it, named as the provider names it', async () => {
    const { service, put, create } = build({ represent: () => representation })
    expect(await service.keep('org-1', 'doc-1', FiscalEvidenceKind.DTE_FILE)).not.toBeNull()
    const [key, bytes, type] = put.mock.calls[0] as [string, Buffer, string]
    expect(key.endsWith('/ABC.json')).toBe(true)
    expect(type).toBe('application/json')
    expect(JSON.parse(bytes.toString('utf8'))).toEqual(representation.file?.content)
    expect((create.mock.calls[0] as [{ data: unknown }])[0].data).toMatchObject({
      filename: 'ABC.json',
      contentType: 'application/json',
      fiscalEvidenceKind: FiscalEvidenceKind.DTE_FILE
    })
  })

  it('only puts a plain file name in the key and the row, whatever the provider says', async () => {
    const hostile = {
      ...representation,
      file: { content: {}, filename: '../x y/z.json' }
    }
    const { service, put, create } = build({ represent: () => hostile })
    await service.keep('org-1', 'doc-1', FiscalEvidenceKind.DTE_FILE)
    const name = (create.mock.calls[0] as [{ data: { filename: string } }])[0].data.filename
    expect(name).toMatch(/^[A-Za-z0-9._-]+$/)
    expect((put.mock.calls[0] as [string])[0]).not.toContain('..')
  })

  it('keeps the picture as a PDF with the same name', async () => {
    const { service, put, create } = build({ represent: () => representation })
    expect(await service.keep('org-1', 'doc-1', FiscalEvidenceKind.REPRESENTATION)).not.toBeNull()
    const [, bytes, type] = put.mock.calls[0] as [string, Buffer, string]
    expect(type).toBe('application/pdf')
    expect(bytes.subarray(0, 5).toString('latin1')).toBe('%PDF-')
    expect((create.mock.calls[0] as [{ data: unknown }])[0].data).toMatchObject({
      filename: 'ABC.pdf',
      contentType: 'application/pdf'
    })
  })

  it('has none from a provider without a representation, or for a type it does not draw', async () => {
    for (const provider of [{}, { represent: () => null }]) {
      const { service, put } = build(provider)
      for (const kind of [FiscalEvidenceKind.DTE_FILE, FiscalEvidenceKind.REPRESENTATION]) {
        expect(await service.keep('org-1', 'doc-1', kind)).toBeNull()
      }
      expect(put).not.toHaveBeenCalled()
    }
  })

  it('has no file when the provider keeps none (the picture can still be drawn)', async () => {
    const { service } = build({ represent: () => ({ ...representation, file: null }) })
    expect(await service.keep('org-1', 'doc-1', FiscalEvidenceKind.DTE_FILE)).toBeNull()
  })

  it('never lets a fault of the provider reach the caller: it is logged and nothing is kept', async () => {
    const { service, put, logger } = build({
      represent: () => {
        throw new Error('boom')
      }
    })
    expect(await service.keep('org-1', 'doc-1', FiscalEvidenceKind.REPRESENTATION)).toBeNull()
    expect(put).not.toHaveBeenCalled()
    expect(logger.error).toHaveBeenCalled()
  })

  it('does not make them for a document that was voided before they were made, but serves the ones it has', async () => {
    const voided = build(
      { represent: () => representation },
      { status: FiscalDocumentStatus.VOIDED }
    )
    for (const kind of [FiscalEvidenceKind.DTE_FILE, FiscalEvidenceKind.REPRESENTATION]) {
      expect(await voided.service.keep('org-1', 'doc-1', kind)).toBeNull()
    }
    expect(voided.put).not.toHaveBeenCalled()
    const kept = build(
      { represent: () => representation },
      {
        status: FiscalDocumentStatus.VOIDED,
        existing: { id: 'media-9', key: 'k', status: 'clean' }
      }
    )
    expect(await kept.service.keep('org-1', 'doc-1', FiscalEvidenceKind.REPRESENTATION)).toEqual({
      mediaId: 'media-9'
    })
  })

  it('tells the person, with a reason, that a picture is too large to be drawn', async () => {
    const huge = {
      ...representation,
      footnotes: [
        {
          label: 'Observaciones',
          value: 'x'.repeat(FiscalLimits.REPRESENTATION_MAX_TEXT_CHARS + 1)
        }
      ]
    }
    const { service, put } = build({ represent: () => huge })
    await expect(
      service.keep('org-1', 'doc-1', FiscalEvidenceKind.REPRESENTATION)
    ).rejects.toMatchObject({
      metadata: { reason: FiscalConflictReasons.REPRESENTATION_TOO_LARGE }
    })
    expect(put).not.toHaveBeenCalled()
    // The file of the document is not the picture: it is still made
    expect(await service.keep('org-1', 'doc-1', FiscalEvidenceKind.DTE_FILE)).not.toBeNull()
  })
})

const voidRepresentation: FiscalRepresentation = {
  ...representation,
  title: 'Evento de invalidación',
  name: 'EVT',
  qrUrl: null,
  file: {
    filename: 'EVT.json',
    content: { ...EVENT, firmaElectronica: 'JWS', selloRecibido: 'S2' }
  }
}
const VOIDED = {
  status: FiscalDocumentStatus.VOIDED,
  row: {
    voidEventEncrypted: new Uint8Array([9]),
    voidedAt: new Date('2026-11-18T15:00:00.000Z'),
    voidResponse: { selloRecibido: 'S2' }
  }
}

describe('the files the receiver is owed for an invalidation', () => {
  const VOID_KINDS = [FiscalEvidenceKind.VOID_DTE_FILE, FiscalEvidenceKind.VOID_REPRESENTATION]

  it('hands the provider the event as it was sealed and the answer of the authority, and keeps its file', async () => {
    const representVoid = jest.fn(() => voidRepresentation)
    const { service, put, create } = build({ representVoid }, VOIDED)
    expect(await service.keep('org-1', 'doc-1', FiscalEvidenceKind.VOID_DTE_FILE)).not.toBeNull()
    expect(representVoid).toHaveBeenCalledWith(
      expect.objectContaining({
        voidEvent: { content: EVENT, signature: 'JWS' },
        voidResponse: { selloRecibido: 'S2' }
      })
    )
    const [key, bytes, type] = put.mock.calls[0] as [string, Buffer, string]
    expect(key.endsWith('/EVT.json')).toBe(true)
    expect(type).toBe('application/json')
    expect(JSON.parse(bytes.toString('utf8'))).toEqual(voidRepresentation.file?.content)
    expect((create.mock.calls[0] as [{ data: unknown }])[0].data).toMatchObject({
      filename: 'EVT.json',
      fiscalEvidenceKind: FiscalEvidenceKind.VOID_DTE_FILE
    })
  })

  it('does not need the built document: a payload that cannot be opened never keeps the receiver from the files of the invalidation', async () => {
    const { service, put } = build(
      { representVoid: () => voidRepresentation },
      { ...VOIDED, row: { ...VOIDED.row, builtPayloadEncrypted: null } }
    )
    expect(await service.keep('org-1', 'doc-1', FiscalEvidenceKind.VOID_DTE_FILE)).not.toBeNull()
    expect(put).toHaveBeenCalled()
  })

  it('keeps the picture of the event as a PDF', async () => {
    const { service, put, create } = build({ representVoid: () => voidRepresentation }, VOIDED)
    expect(
      await service.keep('org-1', 'doc-1', FiscalEvidenceKind.VOID_REPRESENTATION)
    ).not.toBeNull()
    const [, bytes, type] = put.mock.calls[0] as [string, Buffer, string]
    expect(type).toBe('application/pdf')
    expect(bytes.subarray(0, 5).toString('latin1')).toBe('%PDF-')
    expect((create.mock.calls[0] as [{ data: unknown }])[0].data).toMatchObject({
      filename: 'EVT.pdf',
      contentType: 'application/pdf'
    })
  })

  it('exists only once the document is voided', async () => {
    for (const status of [FiscalDocumentStatus.ACCEPTED, FiscalDocumentStatus.REJECTED]) {
      const { service, put } = build(
        { representVoid: () => voidRepresentation },
        { ...VOIDED, status }
      )
      for (const kind of VOID_KINDS) expect(await service.keep('org-1', 'doc-1', kind)).toBeNull()
      expect(put).not.toHaveBeenCalled()
    }
  })

  it('makes nothing when the document holds no event of ours: the file is never invented from the answer', async () => {
    const representVoid = jest.fn(() => voidRepresentation)
    const { service, put } = build(
      { representVoid },
      { ...VOIDED, row: { ...VOIDED.row, voidEventEncrypted: null } }
    )
    for (const kind of VOID_KINDS) expect(await service.keep('org-1', 'doc-1', kind)).toBeNull()
    expect(representVoid).not.toHaveBeenCalled()
    expect(put).not.toHaveBeenCalled()
  })

  it('makes nothing from a provider without them, or when it cannot make a complete one', async () => {
    for (const provider of [{}, { representVoid: () => null }]) {
      const { service, put } = build(provider, VOIDED)
      for (const kind of VOID_KINDS) expect(await service.keep('org-1', 'doc-1', kind)).toBeNull()
      expect(put).not.toHaveBeenCalled()
    }
  })

  it('has no file when the provider keeps none (the picture can still be drawn)', async () => {
    const { service } = build(
      { representVoid: () => ({ ...voidRepresentation, file: null }) },
      VOIDED
    )
    expect(await service.keep('org-1', 'doc-1', FiscalEvidenceKind.VOID_DTE_FILE)).toBeNull()
    expect(
      await service.keep('org-1', 'doc-1', FiscalEvidenceKind.VOID_REPRESENTATION)
    ).not.toBeNull()
  })

  it('never lets a fault of the provider reach the caller, and never logs the event', async () => {
    const { service, put, logger } = build(
      {
        representVoid: () => {
          throw new Error('boom JWS')
        }
      },
      VOIDED
    )
    expect(await service.keep('org-1', 'doc-1', FiscalEvidenceKind.VOID_DTE_FILE)).toBeNull()
    expect(put).not.toHaveBeenCalled()
    expect(JSON.stringify(logger.error.mock.calls)).not.toContain('JWS')
  })

  it('tells the person, with a reason, that the picture of the event is too large to be drawn', async () => {
    const huge = {
      ...voidRepresentation,
      footnotes: [{ label: 'x', value: 'x'.repeat(FiscalLimits.REPRESENTATION_MAX_TEXT_CHARS + 1) }]
    }
    const { service } = build({ representVoid: () => huge }, VOIDED)
    await expect(
      service.keep('org-1', 'doc-1', FiscalEvidenceKind.VOID_REPRESENTATION)
    ).rejects.toMatchObject({
      metadata: { reason: FiscalConflictReasons.REPRESENTATION_TOO_LARGE }
    })
  })

  it('is part of what is kept when the document is decided, and a fault of one never stops the others', async () => {
    const { service, put } = build({ representVoid: () => voidRepresentation }, VOIDED)
    await service.keepAll('org-1', 'doc-1')
    const names = put.mock.calls.map(call => (call as [string])[0].split('/').pop())
    expect(names).toEqual(expect.arrayContaining(['EVT.json', 'EVT.pdf']))
  })
})
