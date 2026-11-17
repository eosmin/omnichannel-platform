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
    consults: number
    signs: number
    userAgents: Set<string>
    environments: Set<string>
    lastDocument: Record<string, unknown> | null
    lastJws: string | null
    // What reached the address a redirect pointed to (nothing, when redirects are refused)
    capturedBodies: string[]
  }
  // The tokens issued so far stop being good (the authority renewed its keys)
  expireTokens(): void
  // Forget the documents it received (a test that reuses the number of a document does not meet a duplicate of another test)
  forgetDocuments(): void
  // Stop answering the signer, as a service that is down
  signerDown: boolean
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
  const stats: FakeAuthority['stats'] = {
    logins: 0,
    wrongLogins: 0,
    receptions: 0,
    consults: 0,
    signs: 0,
    userAgents: new Set(),
    environments: new Set(),
    lastDocument: null,
    lastJws: null,
    capturedBodies: []
  }
  const control = {
    signerDown: false,
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

      if (path === '/fesv/recepciondte') {
        stats.receptions += 1
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
          estado: 'PROCESADO',
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
    close: () =>
      new Promise<void>(resolve => {
        server.closeAllConnections()
        server.close(() => resolve())
      })
  }
}
