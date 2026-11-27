import { createHash, createSign, createVerify, generateKeyPairSync } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'

import { FiscalEnvironment } from '@platform/core/domain'

import type { SvEndpoints } from '../sv-constants'

import { schemaErrors } from './sv-fixtures'

// A server of our own that plays the authority (login, reception, consultation) and its signing service, for the specs of the client. It
// validates what it receives the way the real one does at the edges that matter: the token, the signature, and the schema of the document.
// Nothing here talks to the real authority, and no real certificate is read: the signing key is generated for each run.

export const FAKE = {
  NIT: '06140101011011',
  API_PASSWORD: 'Api-Password-1234!',
  KEY_PASSWORD: 'Key-Password-5678',
  // The receiver whose number says what the authority does with the document
  REJECT: '99999999999901',
  DOWN: '99999999999902',
  SLOW: '99999999999903',
  LOST: '99999999999904',
  OBSERVED: '99999999999905',
  // Says the document is already there, though it never received it (a control number used before)
  GHOST: '99999999999906'
} as const

const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })

const base64url = (data: Buffer | string): string => Buffer.from(data).toString('base64url')

export function signJws(document: unknown): string {
  const head = base64url(JSON.stringify({ alg: 'RS512' }))
  const body = base64url(JSON.stringify(document))
  const signature = createSign('RSA-SHA512').update(`${head}.${body}`).sign(privateKey)
  return `${head}.${body}.${base64url(signature)}`
}

export function verifyJws(jws: string): Record<string, unknown> | null {
  const [head, body, signature] = jws.split('.')
  if (head === undefined || body === undefined || signature === undefined) return null
  const ok = createVerify('RSA-SHA512')
    .update(`${head}.${body}`)
    .verify(publicKey, Buffer.from(signature, 'base64url'))
  return ok
    ? (JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as Record<string, unknown>)
    : null
}

export interface FakeAuthority {
  readonly baseUrl: string
  readonly endpoints: typeof SvEndpoints
  readonly stats: {
    logins: number
    wrongLogins: number
    receptions: number
    invalidations: number
    // The events of contingency it received
    contingencies: number
    consults: number
    signs: number
    userAgents: Set<string>
    environments: Set<string>
    lastDocument: Record<string, unknown> | null
    lastJws: string | null
    // The last event of invalidation it received, decoded
    lastEvent: Record<string, unknown> | null
    // The last event of contingency it received, decoded
    lastContingency: Record<string, unknown> | null
    // What reached the address a redirect pointed to (nothing, when redirects are refused)
    capturedBodies: string[]
  }
  // The tokens issued so far stop being good (the authority renewed its keys)
  expireTokens(): void
  // Forget the documents it received (a test that reuses the number of a document does not meet a duplicate of another test)
  forgetDocuments(): void
  // Stop answering the signer, as a service that is down
  signerDown: boolean
  // The reception of documents answers 503 (the authority is down) while it is true; login and the contingency event still answer
  receptionDown: boolean
  // The event of contingency: taken, refused with a code, or not answered (503)
  contingencyMode: 'normal' | 'refuse' | 'down'
  loginMode: 'normal' | 'rateLimited' | 'redirect'
  close(): Promise<void>
}

const readBody = (request: IncomingMessage): Promise<string> =>
  new Promise(resolve => {
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => chunks.push(chunk))
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
  })

const send = (response: ServerResponse, status: number, body: unknown): void => {
  response.writeHead(status, { 'Content-Type': 'application/json' })
  response.end(JSON.stringify(body))
}

const sealOf = (code: string): string =>
  createHash('sha1').update(code).digest('hex').toUpperCase().padEnd(40, '0').slice(0, 40)

export async function startFakeAuthority(): Promise<FakeAuthority> {
  let tokens = new Set<string>()
  let issued = 0
  const received = new Map<string, { type: string; seal: string }>()
  // The documents whose invalidation it accepted
  const invalidated = new Set<string>()
  // The generation codes of the events it received: one sent again is a duplicate (code 4)
  const eventCodes = new Set<string>()
  // The documents a contingency event listed (by generation code), with the instant the authority took the event: a deferred document is
  // taken only if it is listed. The window of 72 hours is not enforced by this fake.
  const listed = new Map<string, number>()
  const stats: FakeAuthority['stats'] = {
    logins: 0,
    wrongLogins: 0,
    receptions: 0,
    invalidations: 0,
    contingencies: 0,
    consults: 0,
    signs: 0,
    userAgents: new Set(),
    environments: new Set(),
    lastDocument: null,
    lastJws: null,
    lastEvent: null,
    lastContingency: null,
    capturedBodies: []
  }
  const control = {
    signerDown: false,
    receptionDown: false,
    contingencyMode: 'normal' as 'normal' | 'refuse' | 'down',
    loginMode: 'normal' as 'normal' | 'rateLimited' | 'redirect'
  }
  // The documents that found the authority down once: it answers them on the next attempt
  const wasDown = new Set<string>()

  const server: Server = createServer((request, response) => {
    void (async () => {
      const path = request.url ?? ''
      const raw = await readBody(request)
      // The user agent of the calls to the authority (the signing service is ours, and is not told one)
      if (path !== '/firmardocumento/' && request.headers['user-agent'] !== undefined)
        stats.userAgents.add(String(request.headers['user-agent']))

      if (path === '/captured') {
        stats.capturedBodies.push(raw)
        send(response, 200, { status: 'OK' })
        return
      }

      if (path === '/seguridad/auth') {
        if (control.loginMode === 'rateLimited') {
          send(response, 429, { message: 'Too many requests' })
          return
        }
        if (control.loginMode === 'redirect') {
          // A redirect to another address: what the client must never follow with a password in its body
          response.statusCode = 307
          response.setHeader('Location', '/captured')
          response.end()
          return
        }
        const form = new URLSearchParams(raw)
        // Three wrong logins lock the user
        const locked = stats.wrongLogins >= 3
        if (!locked && form.get('user') === FAKE.NIT && form.get('pwd') === FAKE.API_PASSWORD) {
          stats.logins += 1
          issued += 1
          const token = `Bearer fake-token-${issued}`
          tokens.add(token)
          send(response, 200, {
            status: 'OK',
            body: { user: FAKE.NIT, token, tokenType: 'Bearer' }
          })
          return
        }
        stats.wrongLogins += 1
        send(response, 401, {
          status: 'ERROR',
          error: 'Unauthorized',
          message: 'Usuario no valido'
        })
        return
      }

      if (path === '/firmardocumento/') {
        stats.signs += 1
        if (control.signerDown) {
          response.destroy()
          return
        }
        const body = JSON.parse(raw) as {
          nit?: string
          passwordPri?: string
          dteJson?: unknown
          activo?: boolean
        }
        // The request the real service reads: JSON with an active taxpayer and the document as an object (else it answers 809, data required)
        const wellFormed =
          String(request.headers['content-type']).startsWith('application/json') &&
          body.activo === true &&
          typeof body.dteJson === 'object' &&
          body.dteJson !== null
        if (!wellFormed) {
          send(response, 200, {
            status: 'ERROR',
            body: { codigo: '809', mensaje: ['Son datos requeridos'] }
          })
          return
        }
        if (body.nit !== FAKE.NIT || body.passwordPri !== FAKE.KEY_PASSWORD) {
          send(response, 200, {
            status: 'ERROR',
            body: { codigo: '803', mensaje: ['No existe llave publica para este nit'] }
          })
          return
        }
        send(response, 200, { status: 'OK', body: signJws(body.dteJson) })
        return
      }

      const token = String(request.headers['authorization'] ?? '')
      if (!tokens.has(token)) {
        send(response, 401, { status: 'ERROR', error: 'Unauthorized', message: 'Token invalido' })
        return
      }

      if (path === '/fesv/contingencia') {
        stats.contingencies += 1
        const body = JSON.parse(raw) as { nit?: string; documento?: string }
        const refusal = (code: string): void =>
          send(response, 400, {
            estado: 'RECHAZADO',
            selloRecibido: null,
            fechaHora: null,
            codigoMsg: code,
            descripcionMsg: 'REFUSED',
            observaciones: null
          })
        if (control.contingencyMode === 'down') {
          send(response, 503, { error: 'Service Unavailable' })
          return
        }
        if (control.contingencyMode === 'refuse') return refusal('020')
        const event = verifyJws(String(body.documento))
        if (!String(request.headers['content-type']).startsWith('application/json')) {
          return refusal('094')
        }
        if (event === null || body.nit !== FAKE.NIT) return refusal('033')
        stats.lastContingency = event
        if (schemaErrors('contingency', event).length > 0) return refusal('006')
        const eventCode = (event['identificacion'] as { codigoGeneracion: string }).codigoGeneracion
        // The same event sent again is refused as the authority refuses a repeated document (code 4): it holds it already
        if (eventCodes.has(`contingency:${eventCode}`)) return refusal('004')
        const detail = event['detalleDTE'] as { codigoGeneracion: string }[]
        const took = Date.now()
        eventCodes.add(`contingency:${eventCode}`)
        for (const item of detail)
          if (!listed.has(item.codigoGeneracion)) listed.set(item.codigoGeneracion, took)
        send(response, 200, {
          estado: 'RECIBIDO',
          fechaHora: '17/11/2026 09:00:00',
          mensaje: 'RECIBIDO',
          selloRecibido: sealOf(`contingency:${eventCode}`),
          observaciones: []
        })
        return
      }

      if (path === '/fesv/recepciondte') {
        stats.receptions += 1
        if (control.receptionDown) {
          send(response, 503, { error: 'Service Unavailable' })
          return
        }
        const body = JSON.parse(raw) as {
          idEnvio?: unknown
          version?: unknown
          ambiente?: string
          documento?: string
          codigoGeneracion?: string
          tipoDte?: string
        }
        stats.environments.add(String(body.ambiente))
        const document = verifyJws(String(body.documento))
        const refusal = (code: string): void =>
          send(response, 400, {
            version: 2,
            ambiente: body.ambiente,
            estado: 'RECHAZADO',
            codigoGeneracion: body.codigoGeneracion,
            selloRecibido: null,
            fhProcesamiento: null,
            codigoMsg: code,
            descripcionMsg: 'REFUSED',
            observaciones: null
          })
        // The shape of the request: an integer number of shipment and the version of the document
        if (
          !String(request.headers['content-type']).startsWith('application/json') ||
          !Number.isInteger(body.idEnvio) ||
          typeof body.version !== 'number'
        ) {
          return refusal('094')
        }
        if (document === null) return refusal('033')
        stats.lastDocument = document
        stats.lastJws = String(body.documento)
        const id = document['identificacion'] as { codigoGeneracion: string; tipoDte: string }
        if (id.codigoGeneracion !== body.codigoGeneracion || id.tipoDte !== body.tipoDte)
          return refusal('027')
        if (schemaErrors(id.tipoDte, document).length > 0) return refusal('006')
        // A document made in contingency (operation 2) is taken only after an event listed it (a code of OUR fake: the real one is to be
        // confirmed in the sandbox)
        const operation = (document['identificacion'] as { tipoOperacion?: number }).tipoOperacion
        if (operation === 2 && !listed.has(id.codigoGeneracion)) return refusal('056')
        const receiver = (document['receptor'] ?? {}) as { numDocumento?: string; nit?: string }
        const who = receiver.numDocumento ?? receiver.nit ?? ''
        if (who === FAKE.REJECT) return refusal('020')
        if (who === FAKE.DOWN && !wasDown.has(id.codigoGeneracion)) {
          wasDown.add(id.codigoGeneracion)
          send(response, 503, { error: 'Service Unavailable' })
          return
        }
        if (who === FAKE.SLOW) return // never answers
        if (who === FAKE.GHOST) return refusal('004')
        // A document that is already there is refused as the authority refuses it (code 4)
        if (received.has(String(body.codigoGeneracion))) return refusal('004')
        const seal = sealOf(body.codigoGeneracion ?? '')
        received.set(String(body.codigoGeneracion), { type: id.tipoDte, seal })
        if (who === FAKE.LOST) {
          request.socket.destroy()
          return
        }
        send(response, 200, {
          version: 2,
          ambiente: body.ambiente,
          versionApp: 2,
          estado: 'PROCESADO',
          codigoGeneracion: body.codigoGeneracion,
          selloRecibido: seal,
          fhProcesamiento: '17/11/2026 09:00:00',
          clasificaMsg: '10',
          codigoMsg: who === FAKE.OBSERVED ? '002' : '001',
          descripcionMsg: who === FAKE.OBSERVED ? 'RECIBIDO CON OBSERVACIONES' : 'RECIBIDO',
          observaciones:
            who === FAKE.OBSERVED ? ['identificacion.fecEmi Difiere de la fecha de envío.'] : []
        })
        return
      }

      if (path === '/fesv/anulardte') {
        stats.invalidations += 1
        const body = JSON.parse(raw) as {
          idEnvio?: unknown
          version?: unknown
          ambiente?: string
          documento?: string
        }
        const refusal = (code: string, observations: string[] | null = null): void =>
          send(response, 400, {
            version: 3,
            ambiente: body.ambiente,
            estado: 'RECHAZADO',
            selloRecibido: null,
            fhProcesamiento: null,
            codigoMsg: code,
            descripcionMsg: 'REFUSED',
            observaciones: observations
          })
        const event = verifyJws(String(body.documento))
        if (
          !String(request.headers['content-type']).startsWith('application/json') ||
          !Number.isInteger(body.idEnvio) ||
          body.version !== 3
        ) {
          return refusal('094')
        }
        if (event === null) return refusal('033')
        stats.lastEvent = event
        if (schemaErrors('invalidation', event).length > 0) return refusal('006')
        const eventCode = (event['identificacion'] as { codigoGeneracion: string }).codigoGeneracion
        const original = event['documento'] as {
          codigoGeneracion: string
          selloRecibido: string
          codigoGeneracionR: string | null
        }
        const motivo = event['motivo'] as { tipoAnulacion: number; numDocSolicita: string }
        const known = received.get(original.codigoGeneracion)
        // The document must be there, with the seal the authority gave it
        if (known === undefined || known.seal !== original.selloRecibido) return refusal('014')
        // An event with a code the authority holds already says so naming the field (the shape of the real answer is to be confirmed)
        if (eventCodes.has(eventCode)) {
          return refusal('004', [
            '[identificacion.codigoGeneracion] YA EXISTE UN REGISTRO CON ESE VALOR'
          ])
        }
        if (invalidated.has(original.codigoGeneracion)) return refusal('053')
        // A correction and another reason name a replacement the authority has
        if (motivo.tipoAnulacion !== 2 && !received.has(String(original.codigoGeneracionR))) {
          return refusal('054')
        }
        if (motivo.numDocSolicita === FAKE.REJECT) return refusal('020')
        if (
          motivo.numDocSolicita === FAKE.DOWN &&
          !wasDown.has(`void:${original.codigoGeneracion}`)
        ) {
          wasDown.add(`void:${original.codigoGeneracion}`)
          send(response, 503, { error: 'Service Unavailable' })
          return
        }
        invalidated.add(original.codigoGeneracion)
        eventCodes.add(eventCode)
        // It accepted and the answer is lost
        if (motivo.numDocSolicita === FAKE.LOST) {
          request.socket.destroy()
          return
        }
        send(response, 200, {
          version: 3,
          ambiente: body.ambiente,
          estado: 'PROCESADO',
          selloRecibido: sealOf(`event:${original.codigoGeneracion}`),
          fhProcesamiento: '18/11/2026 09:00:00',
          codigoMsg: '001',
          descripcionMsg: 'RECIBIDO',
          observaciones: []
        })
        return
      }

      if (path === '/fesv/recepcion/consultadte') {
        stats.consults += 1
        const body = JSON.parse(raw) as { codigoGeneracion?: string; nitEmisor?: string }
        const known = received.get(String(body.codigoGeneracion))
        if (known === undefined || body.nitEmisor !== FAKE.NIT) {
          send(response, 400, {
            estado: 'RECHAZADO',
            codigoMsg: '014',
            descripcionMsg: 'NO EXISTE UN REGISTRO CON ESTE DATO',
            selloRecibido: null,
            observaciones: null
          })
          return
        }
        send(response, 200, {
          version: 2,
          estado: invalidated.has(String(body.codigoGeneracion)) ? 'INVALIDADO' : 'PROCESADO',
          codigoGeneracion: body.codigoGeneracion,
          selloRecibido: known.seal,
          fhProcesamiento: '17/11/2026 09:00:00',
          codigoMsg: '001',
          descripcionMsg: 'RECIBIDO',
          observaciones: []
        })
        return
      }
      send(response, 400, { error: 'Unknown route' })
    })().catch(() => {
      response.destroy()
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const one = {
    baseUrl,
    auth: '/seguridad/auth',
    reception: '/fesv/recepciondte',
    consult: '/fesv/recepcion/consultadte',
    invalidation: '/fesv/anulardte',
    contingency: '/fesv/contingencia'
  }
  return {
    baseUrl,
    endpoints: { [FiscalEnvironment.SANDBOX]: one, [FiscalEnvironment.PRODUCTION]: one },
    stats,
    expireTokens: () => {
      tokens = new Set()
    },
    forgetDocuments: () => {
      received.clear()
      invalidated.clear()
      eventCodes.clear()
      listed.clear()
      wasDown.clear()
    },
    get signerDown() {
      return control.signerDown
    },
    set signerDown(value: boolean) {
      control.signerDown = value
    },
    get loginMode() {
      return control.loginMode
    },
    set loginMode(value: 'normal' | 'rateLimited' | 'redirect') {
      control.loginMode = value
    },
    get receptionDown() {
      return control.receptionDown
    },
    set receptionDown(value: boolean) {
      control.receptionDown = value
    },
    get contingencyMode() {
      return control.contingencyMode
    },
    set contingencyMode(value: 'normal' | 'refuse' | 'down') {
      control.contingencyMode = value
    },
    close: () =>
      new Promise<void>(resolve => {
        server.closeAllConnections()
        server.close(() => resolve())
      })
  }
}
