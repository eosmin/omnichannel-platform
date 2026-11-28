import { FiscalVoidKind } from '@platform/core/domain'
import type { StoredVoidedDocument } from '@platform/fiscal/sdk'

import { SvRepresentation } from './sv-constants'
import { buildInvalidation, invalidationCode } from './sv-invalidation'
import { representVoid } from './sv-representation'
import { acceptedDocument, ISSUER } from './testing/sv-fixtures'

const SEAL = 'F1E2D3C4B5A60718293A4B5C6D7E8F9012345678'
const JWS = 'eyJhbGciOiJSUzUxMiJ9.eyJldmVudCI6dHJ1ZX0.c2ln'
const NOW = '2026-11-18T15:00:00.000Z'

function voided(
  over: { kind?: FiscalVoidKind; response?: Record<string, unknown> | null } = {}
): StoredVoidedDocument {
  const doc = acceptedDocument()
  const built = buildInvalidation({
    doc,
    issuer: ISSUER,
    reason: 'Datos del cliente equivocados',
    details: {
      kind: over.kind ?? FiscalVoidKind.RESCISSION,
      responsible: { name: 'Ana Pérez', idType: '13', idNumber: '012345678' },
      requester: { name: 'Luis Gómez', idType: '36', idNumber: '06140101011011' }
    },
    code: invalidationCode('key-1'),
    now: NOW
  })
  if (!built.ok) throw new Error(`the fixture is refused: ${built.reason}`)
  return {
    ...doc,
    voidEvent: { content: built.event, signature: JWS },
    voidResponse: over.response === undefined ? { selloRecibido: SEAL } : over.response
  }
}

const valueOf = (
  rep: ReturnType<typeof representVoid>,
  heading: string,
  label: string
): string | undefined =>
  rep?.sections.find(section => section.heading === heading)?.rows.find(r => r.label === label)
    ?.value

describe('the representation of the invalidation of a document', () => {
  it('draws the identification, the document invalidated and the people of the event, with the seal of the answer', () => {
    const rep = representVoid(voided())
    expect(rep?.title).toBe(SvRepresentation.VOID_TITLE)
    expect(rep?.name).toBe(invalidationCode('key-1'))
    expect(valueOf(rep, 'Identificación', 'Sello de Recepción')).toBe(SEAL)
    expect(valueOf(rep, 'Identificación', 'Código de Generación')).toBe(invalidationCode('key-1'))
    expect(valueOf(rep, 'Documento a invalidar', 'Tipo de Documento')).toBe('Factura')
    expect(valueOf(rep, 'Documento a invalidar', 'Sello de Recepción')).toMatch(/^[0-9A-Z]{40}$/)
    expect(valueOf(rep, 'Motivo de la invalidación', 'Tipo de invalidación')).toBe(
      SvRepresentation.VOID_KINDS[2]
    )
    expect(valueOf(rep, 'Motivo de la invalidación', 'Motivo')).toBe(
      'Datos del cliente equivocados'
    )
    expect(valueOf(rep, 'Quien realiza el evento', 'Nombre')).toBe('Ana Pérez')
    expect(valueOf(rep, 'Quien solicita la invalidación', 'Nombre')).toBe('Luis Gómez')
    // A rescission names no document that replaces it
    expect(
      valueOf(rep, 'Documento a invalidar', 'Código de Generación que reemplaza al invalidado')
    ).toBe(SvRepresentation.EMPTY)
    expect(rep?.table).toBeNull()
    expect(rep?.qrUrl).toBeNull()
  })

  it('gives the file of the event as the authority holds it: the event, its signature and the seal of the answer', () => {
    const doc = voided()
    const rep = representVoid(doc)
    expect(rep?.file?.filename).toBe(`${invalidationCode('key-1')}.json`)
    expect(rep?.file?.content).toEqual({
      ...doc.voidEvent.content,
      firmaElectronica: JWS,
      selloRecibido: SEAL
    })
  })

  it.each([
    ['no answer', null],
    ['an answer with no seal', { estado: 'PROCESADO' }],
    ['an answer whose seal is empty', { selloRecibido: '  ' }]
  ])('makes nothing with %s: the file is never made incomplete', (_name, response) => {
    expect(representVoid(voided({ response }))).toBeNull()
  })

  it('makes nothing when the signature is empty or the event is not the shape of the schema', () => {
    const doc = voided()
    expect(representVoid({ ...doc, voidEvent: { ...doc.voidEvent, signature: '' } })).toBeNull()
    expect(representVoid({ ...doc, voidEvent: { content: {}, signature: JWS } })).toBeNull()
    expect(
      representVoid({
        ...doc,
        voidEvent: {
          content: { ...doc.voidEvent.content, documento: 'x' },
          signature: JWS
        }
      })
    ).toBeNull()
  })

  it('warns that an event of the test environment has no legal value', () => {
    const doc = voided()
    const content = {
      ...doc.voidEvent.content,
      identificacion: {
        ...(doc.voidEvent.content['identificacion'] as Record<string, unknown>),
        ambiente: '00'
      }
    }
    expect(representVoid({ ...doc, voidEvent: { content, signature: JWS } })?.notices).toEqual([
      SvRepresentation.TEST_NOTICE
    ])
  })

  it('is the same every time for the same event', () => {
    expect(representVoid(voided())).toEqual(representVoid(voided()))
  })
})
