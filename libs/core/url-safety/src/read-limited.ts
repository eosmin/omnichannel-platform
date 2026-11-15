// A body that grew past the limit its reader was given: the stream is destroyed and nothing of it is kept
export class BodyTooLarge extends Error {
  constructor() {
    super('the file is bigger than the limit')
    this.name = 'BodyTooLarge'
  }
}

// Reads a stream whole, up to `maxBytes`. A fetch of a link that came from outside is read with this so that a
// server that sends more than it said cannot fill the memory of the process.
export async function readLimited(
  stream: NodeJS.ReadableStream,
  maxBytes: number
): Promise<Buffer> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of stream) {
    const part = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    total += part.length
    if (total > maxBytes) {
      ;(stream as { destroy?: () => void }).destroy?.()
      throw new BodyTooLarge()
    }
    chunks.push(part)
  }
  return Buffer.concat(chunks)
}
