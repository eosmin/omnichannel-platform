import { Readable } from 'node:stream'

import { limitBytes } from './limit-bytes'

async function read(stream: NodeJS.ReadableStream): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of stream) chunks.push(Buffer.from(chunk as Uint8Array))
  return Buffer.concat(chunks).toString()
}

// A source that records whether it was closed
function sourceOf(chunks: string[]): { source: Readable; closed: () => boolean } {
  let closed = false
  const source = Readable.from(chunks.map(chunk => Buffer.from(chunk)))
  source.on('close', () => {
    closed = true
  })
  return { source, closed: () => closed }
}

describe('limitBytes', () => {
  it('passes a file of exactly the limit', async () => {
    const { source } = sourceOf(['abc', 'de'])
    await expect(read(limitBytes(source, 5, 5))).resolves.toBe('abcde')
  })

  it('fails on the byte after the limit, across chunks, and closes the source', async () => {
    const { source, closed } = sourceOf(['abc', 'def'])

    await expect(read(limitBytes(source, 5, null))).rejects.toMatchObject({ retryable: false })
    await new Promise(resolve => setImmediate(resolve))
    expect(closed()).toBe(true)
  })

  it('fails a stream that ends short of the size it announced, and asks to try again', async () => {
    const { source } = sourceOf(['abc'])
    await expect(read(limitBytes(source, 10, 5))).rejects.toMatchObject({ retryable: true })
  })

  it('does not check the size when none was announced', async () => {
    const { source } = sourceOf(['abc'])
    await expect(read(limitBytes(source, 10, null))).resolves.toBe('abc')
  })

  it('closes the source when the consumer gives up', async () => {
    const { source, closed } = sourceOf(['abc', 'def'])
    const limited = limitBytes(source, 10, null)
    limited.on('error', () => undefined)

    limited.destroy()
    await new Promise(resolve => setImmediate(resolve))

    expect(closed()).toBe(true)
  })

  it('gives a failure of the source as a plugin error that asks to try again', async () => {
    const source = new Readable({
      read(): void {
        this.destroy(new Error('socket hang up'))
      }
    })

    await expect(read(limitBytes(source, 10, null))).rejects.toMatchObject({
      name: 'PluginError',
      retryable: true
    })
  })

  it('fails a source that closes before its end without an error, instead of waiting forever', async () => {
    const source = new Readable({
      read(): void {
        this.push(Buffer.from('ab'))
        this.destroy()
      }
    })

    await expect(read(limitBytes(source, 10, null))).rejects.toMatchObject({ retryable: true })
  })
})
