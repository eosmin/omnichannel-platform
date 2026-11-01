import { createServer, type Server } from 'node:net'
import { Readable } from 'node:stream'

import { ClamavClient, ClamavUnavailable, parseReply } from './clamav.client'

// A daemon that speaks the end of INSTREAM: it keeps what it was sent and answers when the zero-length
// chunk arrives
function fakeClamd(answer: string): Promise<{ server: Server; port: number; received: Buffer[] }> {
  const received: Buffer[] = []
  const server = createServer(socket => {
    let pending = Buffer.alloc(0)
    socket.on('data', chunk => {
      pending = Buffer.concat([pending, chunk])
      received.push(chunk)
      // The command is 10 bytes (`zINSTREAM\0`); the stream ends with a chunk of size 0
      if (pending.length >= 14 && pending.subarray(-4).equals(Buffer.alloc(4))) {
        socket.end(answer)
      }
    })
  })
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      resolve({ server, port: typeof address === 'object' && address ? address.port : 0, received })
    })
  })
}

describe('parseReply', () => {
  it('reads a clean file', () => {
    expect(parseReply('stream: OK\0')).toEqual({ infected: false })
  })

  it('reads the name of what was found', () => {
    expect(parseReply('stream: Eicar-Test-Signature FOUND\0')).toEqual({
      infected: true,
      viruses: ['Eicar-Test-Signature']
    })
  })

  it('never takes an error or a silence for a clean file', () => {
    expect(() => parseReply('INSTREAM size limit exceeded. ERROR\0')).toThrow(ClamavUnavailable)
    expect(() => parseReply('')).toThrow(ClamavUnavailable)
    expect(() => parseReply('stream: OK but not quite')).toThrow(ClamavUnavailable)
  })
})

describe('ClamavClient', () => {
  let server: Server | undefined
  afterEach(() => {
    server?.close()
    server = undefined
  })

  it('streams the file in length-prefixed chunks and ends with an empty one', async () => {
    const fake = await fakeClamd('stream: OK\0')
    server = fake.server
    const body = Buffer.from('hello world')

    const verdict = await new ClamavClient({ host: '127.0.0.1', port: fake.port }).scan(
      Readable.from([body])
    )

    expect(verdict).toEqual({ infected: false })
    const wire = Buffer.concat(fake.received)
    expect(wire.subarray(0, 10).toString()).toBe('zINSTREAM\0')
    expect(wire.readUInt32BE(10)).toBe(body.length)
    expect(wire.subarray(14, 14 + body.length).equals(body)).toBe(true)
    expect(wire.subarray(-4).equals(Buffer.alloc(4))).toBe(true)
  })

  it('reports an infected file', async () => {
    const fake = await fakeClamd('stream: Win.Test.EICAR_HDB-1 FOUND\0')
    server = fake.server

    const verdict = await new ClamavClient({ host: '127.0.0.1', port: fake.port }).scan(
      Readable.from([Buffer.from('x')])
    )

    expect(verdict).toEqual({ infected: true, viruses: ['Win.Test.EICAR_HDB-1'] })
  })

  it('gives no verdict when the daemon is not there', async () => {
    const fake = await fakeClamd('stream: OK\0')
    const { port } = fake
    await new Promise(resolve => fake.server.close(resolve))

    await expect(
      new ClamavClient({ host: '127.0.0.1', port }).scan(Readable.from([Buffer.from('x')]))
    ).rejects.toBeInstanceOf(ClamavUnavailable)
  })

  it('gives no verdict when the daemon answers an error', async () => {
    const fake = await fakeClamd('Can not allocate memory ERROR\0')
    server = fake.server

    await expect(
      new ClamavClient({ host: '127.0.0.1', port: fake.port }).scan(
        Readable.from([Buffer.from('x')])
      )
    ).rejects.toBeInstanceOf(ClamavUnavailable)
  })
})
