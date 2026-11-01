import { once } from 'node:events'
import { connect } from 'node:net'
import type { Readable } from 'node:stream'

import type { ClamavAddress } from '@platform/core/http'
import { VirusScan } from '@platform/core/storage'

export type ScanVerdict = { infected: false } | { infected: true; viruses: string[] }

// What clamd answers to INSTREAM: `stream: OK`, `stream: <name> FOUND` or `<text> ERROR`. Anything
// else is not a verdict, and a file without a verdict is never taken for a clean one.
export class ClamavUnavailable extends Error {
  constructor(reason: string) {
    super(`the virus scanner gave no verdict: ${reason}`)
    this.name = 'ClamavUnavailable'
  }
}

const asError = (error: unknown): Error =>
  error instanceof Error ? error : new Error(String(error))

export function parseReply(reply: string): ScanVerdict {
  const text = reply.replace(/\0+$/, '').trim()
  if (/^stream: OK$/.test(text)) return { infected: false }
  const found = [...text.matchAll(/^stream: (.+) FOUND$/gm)].map(match => match[1] ?? '')
  if (found.length > 0) return { infected: true, viruses: found }
  throw new ClamavUnavailable(text.length > 0 ? text.slice(0, 200) : 'empty reply')
}

// The clamd protocol over TCP (INSTREAM), without a library: the file is streamed to the daemon in
// length-prefixed chunks and never held in memory or written to disk. A connection per scan.
export class ClamavClient {
  constructor(private readonly address: ClamavAddress) {}

  scan(source: Readable): Promise<ScanVerdict> {
    return new Promise<ScanVerdict>((resolve, reject) => {
      const socket = connect(this.address)
      const replies: Buffer[] = []
      let settled = false
      const ended = new AbortController()
      const finish = (action: () => void): void => {
        if (settled) return
        settled = true
        ended.abort()
        clearTimeout(timer)
        socket.destroy()
        source.destroy()
        action()
      }
      const timer = setTimeout(
        () => finish(() => reject(new ClamavUnavailable('timed out'))),
        VirusScan.TIMEOUT_MS
      )

      socket.on('error', error => finish(() => reject(new ClamavUnavailable(error.message))))
      socket.on('data', chunk => replies.push(chunk))
      socket.on('end', () => {
        finish(() => {
          try {
            resolve(parseReply(Buffer.concat(replies).toString('utf8')))
          } catch (error) {
            reject(asError(error))
          }
        })
      })
      source.on('error', error => finish(() => reject(asError(error))))

      socket.on('connect', () => {
        socket.write('zINSTREAM\0')
        void (async () => {
          try {
            for await (const chunk of source) {
              const part = chunk as Buffer
              for (let at = 0; at < part.length; at += VirusScan.CHUNK_BYTES) {
                const piece = part.subarray(at, at + VirusScan.CHUNK_BYTES)
                const size = Buffer.alloc(4)
                size.writeUInt32BE(piece.length)
                // Respect the back-pressure of the daemon
                if (!socket.write(Buffer.concat([size, piece]))) {
                  // Removes its listener when it settles; aborted when the scan has ended (a socket
                  // that closed will not drain)
                  await once(socket, 'drain', { signal: ended.signal })
                }
              }
            }
            socket.write(Buffer.alloc(4))
          } catch (error) {
            finish(() => reject(asError(error)))
          }
        })()
      })
    })
  }
}
