import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, request as httpsRequest, type Server } from 'node:https'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { readLimited } from './fetch-helpers'
import { type HttpsRequester, PinnedFetchFailed, pinnedHttpsGet } from './pinned-https-get'

// The whole of node's http and tls stack against a real server on this machine. The server stands in
// for `cdn.example.com`: the test resolves that name to a public address (which the check demands),
// and the request is sent to the local port with the certificate of the test as its only root. What
// is proved is what the injected requests cannot show: the certificate is checked against the NAME of
// the link, a redirect is not followed and the body arrives as sent.

const NAME = 'cdn.example.com'
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4])

function certificateFor(dir: string, name: string): { key: Buffer; cert: Buffer } {
  const config = join(dir, `${name}.cnf`)
  writeFileSync(
    config,
    `[req]\ndistinguished_name=dn\nx509_extensions=ext\nprompt=no\n[dn]\nCN=${name}\n[ext]\nsubjectAltName=DNS:${name}\n`
  )
  const key = join(dir, `${name}.key`)
  const cert = join(dir, `${name}.crt`)
  execFileSync(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'ec',
      '-pkeyopt',
      'ec_paramgen_curve:prime256v1',
      '-nodes',
      '-days',
      '1',
      '-config',
      config,
      '-keyout',
      key,
      '-out',
      cert
    ],
    { stdio: 'ignore' }
  )
  return { key: readFileSync(key), cert: readFileSync(cert) }
}

function serve(tls: { key: Buffer; cert: Buffer }): Promise<Server> {
  const server = createServer(tls, (req, res) => {
    if (req.url === '/redirect') {
      res.writeHead(302, { location: 'https://127.0.0.1/internal' }).end()
    } else if (req.url === '/big') {
      res.writeHead(200, { 'content-type': 'image/png' }).end(Buffer.alloc(2048))
    } else {
      res.writeHead(200, { 'content-type': 'image/png', 'content-length': PNG.length }).end(PNG)
    }
  })
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server)))
}

describe('pinnedHttpsGet against a real https server', () => {
  let dir: string
  let right: Server
  let wrong: Server
  let rightCert: Buffer
  let seenLookups: string[]

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'pinned-get-'))
    const good = certificateFor(dir, NAME)
    rightCert = good.cert
    right = await serve(good)
    // A server whose certificate is for another name
    wrong = await serve(certificateFor(dir, 'other.example.org'))
  }, 30_000)
  afterAll(() => {
    right.close()
    wrong.close()
    rmSync(dir, { recursive: true, force: true })
  })
  beforeEach(() => {
    seenLookups = []
  })

  // What the request is told by pinnedHttpsGet is kept to be checked; where it connects is the test's
  const toLocal = (server: Server, ca: Buffer): HttpsRequester =>
    ((options: Parameters<HttpsRequester>[0]) => {
      const pinned = (
        options as unknown as {
          lookup: (h: string, o: object, cb: (...a: unknown[]) => void) => void
        }
      ).lookup
      pinned(NAME, {}, (_error, address) => seenLookups.push(String(address)))
      return httpsRequest({
        ...(options as object),
        port: (server.address() as AddressInfo).port,
        lookup: ((
          _host: string,
          lookupOptions: { all?: boolean },
          callback: (...a: unknown[]) => void
        ) => {
          if (lookupOptions.all === true) callback(null, [{ address: '127.0.0.1', family: 4 }])
          else callback(null, '127.0.0.1', 4)
        }) as never,
        ca
      })
    }) as unknown as HttpsRequester

  const get = (path: string, server = right, ca = rightCert) =>
    pinnedHttpsGet(`https://${NAME}${path}`, {
      accept: 'image/png',
      timeoutMs: 5000,
      resolve: () => Promise.resolve(['8.8.8.8']),
      request: toLocal(server, ca)
    })

  it('reads the headers and the body of a file, and tells the socket the checked address', async () => {
    const response = await get('/a.png')
    expect(response.contentType).toBe('image/png')
    expect(response.contentLength).toBe(PNG.length)
    expect(await readLimited(response.stream, 1024)).toEqual(PNG)
    expect(seenLookups).toEqual(['8.8.8.8'])
  })

  it('does not follow a redirect, however it points', async () => {
    await expect(get('/redirect')).rejects.toMatchObject({
      name: PinnedFetchFailed.name,
      retryable: false
    })
  })

  it('refuses a certificate that is for another name, for good', async () => {
    const otherCert = readFileSync(join(dir, 'other.example.org.crt'))
    await expect(get('/a.png', wrong, otherCert)).rejects.toMatchObject({
      retryable: false,
      message: expect.stringContaining('ERR_TLS_CERT_ALTNAME_INVALID') as string
    })
  })

  it('refuses a certificate the platform does not trust, for good', async () => {
    await expect(
      get('/a.png', right, readFileSync(join(dir, 'other.example.org.crt')))
    ).rejects.toMatchObject({
      retryable: false
    })
  })

  it('leaves the size limit to the reader, which stops a body over it', async () => {
    const response = await get('/big')
    await expect(readLimited(response.stream, 100)).rejects.toThrow('bigger than the limit')
  })
})
