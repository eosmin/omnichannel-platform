import {
  classifyEventAnswer,
  classifyReception,
  SvCredentialCodes,
  SvDuplicateCodes,
  SvTokenCodes,
  SvTransientCodes
} from './sv-responses'

const processed = (extra: Record<string, unknown> = {}) => ({
  estado: 'PROCESADO',
  selloRecibido: 'A'.repeat(40),
  fhProcesamiento: '17/11/2026 09:00:00',
  codigoMsg: '001',
  observaciones: [],
  ...extra
})
const refused = (codigoMsg: string) => ({
  estado: 'RECHAZADO',
  selloRecibido: null,
  codigoMsg,
  observaciones: null
})

describe('what the authority answered to a document', () => {
  it('is accepted when it is processed and has a seal, with its observations', () => {
    expect(classifyReception(200, processed())).toMatchObject({
      kind: 'accepted',
      processedAt: '17/11/2026 09:00:00',
      observations: []
    })
    expect(
      classifyReception(200, processed({ codigoMsg: '002', observaciones: ['a', 7, 'b'] }))
    ).toMatchObject({
      kind: 'accepted',
      observations: ['a', 'b']
    })
  })

  it('is accepted by its seal even when its message code is one of the codes of the authentication service', () => {
    for (const code of ['107', '106', '100']) {
      expect(classifyReception(200, processed({ codigoMsg: code }))).toMatchObject({
        kind: 'accepted'
      })
    }
  })

  it('is not accepted without a seal, whatever its state says', () => {
    expect(classifyReception(200, processed({ selloRecibido: null }))).toEqual({
      kind: 'transient'
    })
    expect(classifyReception(200, processed({ selloRecibido: '' }))).toEqual({ kind: 'transient' })
  })

  it('is refused with the code of the authority, which is kept as it came', () => {
    expect(classifyReception(400, refused('020'))).toMatchObject({ kind: 'rejected', code: '020' })
    expect(classifyReception(400, refused('006'))).toMatchObject({ kind: 'rejected', code: '006' })
    // A refusal that says no code is no verdict on the document
    expect(classifyReception(400, { estado: 'RECHAZADO' })).toEqual({ kind: 'transient' })
  })

  it.each([...SvTransientCodes])(
    'is a fault of the moment, not a refusal, for the code %s (with or without its zeros)',
    code => {
      expect(classifyReception(400, refused(String(code)))).toEqual({ kind: 'transient' })
      expect(classifyReception(400, refused(String(code).padStart(3, '0')))).toEqual({
        kind: 'transient'
      })
    }
  )

  it('keeps the codes that say "try again" out of the refusals: 22 (signature service down), 99 (uncatalogued) and 101 (contact support)', () => {
    // A refusal starts the 24 hours to correct and send again (Normativa DTE apartado 10); these say nothing about the document
    for (const code of [22, 99, 101]) {
      expect(SvTransientCodes.has(code)).toBe(true)
      expect(classifyReception(400, refused(String(code)))).toEqual({ kind: 'transient' })
      expect(classifyEventAnswer(400, refused(String(code)))).toEqual({ kind: 'transient' })
    }
    // A business refusal still is one
    expect(classifyReception(400, refused('020'))).toMatchObject({ kind: 'rejected' })
  })

  it.each([...SvTokenCodes])('asks for another token for the code %s', code => {
    expect(classifyReception(400, refused(String(code)))).toEqual({ kind: 'token' })
  })

  it.each([...SvCredentialCodes])('says the credentials are wrong for the code %s', code => {
    expect(classifyReception(400, refused(String(code)))).toEqual({ kind: 'credentials' })
  })

  it.each([...SvDuplicateCodes])(
    'says the document is already there for the code %s, with its code and answer',
    code => {
      expect(classifyReception(400, refused(String(code)))).toMatchObject({
        kind: 'duplicate',
        code: String(code)
      })
    }
  )

  it('asks for another token on 401 and 403, and calls a 5xx a fault of the moment', () => {
    expect(classifyReception(401, null)).toEqual({ kind: 'token' })
    expect(classifyReception(403, { error: 'x' })).toEqual({ kind: 'token' })
    for (const status of [500, 502, 503, 504])
      expect(classifyReception(status, null)).toEqual({ kind: 'transient' })
  })

  it('is a fault of the moment for an answer nobody knows: a page of a proxy, an empty body, a shape that is not ours', () => {
    expect(classifyReception(200, null)).toEqual({ kind: 'transient' })
    expect(classifyReception(200, 'text')).toEqual({ kind: 'transient' })
    expect(classifyReception(200, { hello: 'world' })).toEqual({ kind: 'transient' })
    expect(classifyReception(404, {})).toEqual({ kind: 'transient' })
  })

  it('keeps the three groups of codes apart: a code is never two things', () => {
    const all = [...SvTransientCodes, ...SvTokenCodes, ...SvCredentialCodes, ...SvDuplicateCodes]
    expect(new Set(all).size).toBe(all.length)
  })
})

describe('what the authority answered to the event of a contingency', () => {
  const taken = (extra: Record<string, unknown> = {}) => ({
    estado: 'RECIBIDO',
    fechaHora: '17/11/2026 09:00:00',
    selloRecibido: 'B'.repeat(40),
    ...extra
  })

  it('is taken with its seal and the instant the authority gave', () => {
    expect(classifyEventAnswer(200, taken())).toMatchObject({
      kind: 'accepted',
      seal: 'B'.repeat(40),
      receivedAtTexts: ['17/11/2026 09:00:00']
    })
  })

  it('reads each way the authority does not take it, the same as a document', () => {
    expect(classifyEventAnswer(401, {})).toEqual({ kind: 'token' })
    expect(classifyEventAnswer(503, {})).toEqual({ kind: 'transient' })
    for (const code of SvTokenCodes) {
      expect(classifyEventAnswer(400, refused(String(code)))).toEqual({ kind: 'token' })
    }
    for (const code of SvCredentialCodes) {
      expect(classifyEventAnswer(400, refused(String(code)))).toEqual({ kind: 'credentials' })
    }
    for (const code of SvTransientCodes) {
      expect(classifyEventAnswer(400, refused(String(code)))).toEqual({ kind: 'transient' })
    }
    for (const code of SvDuplicateCodes) {
      expect(classifyEventAnswer(400, refused(String(code)))).toMatchObject({ kind: 'duplicate' })
    }
    expect(classifyEventAnswer(400, refused('020'))).toMatchObject({
      kind: 'rejected',
      code: '020'
    })
    // A refusal that says no code, and an answer that is not a verdict, are the fault of the moment
    expect(classifyEventAnswer(400, { estado: 'RECHAZADO' })).toEqual({ kind: 'transient' })
    expect(classifyEventAnswer(200, { estado: 'RECIBIDO', selloRecibido: null })).toEqual({
      kind: 'transient'
    })
    expect(classifyEventAnswer(200, '<html>')).toEqual({ kind: 'transient' })
  })
})
