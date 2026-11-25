import { createHash, randomBytes } from 'node:crypto'
import { Readable } from 'node:stream'

import { BlobReader, Uint8ArrayWriter, ZipReader } from '@zip.js/zip.js'

import { ComplianceConfig } from '@platform/core/compliance'

import { type DsrExportContent, DsrExportTooLargeError, dsrFileEntryName } from './dsr-export-data'
import { type DsrFileSource, streamDsrZip } from './dsr-export-zip'

const generatedAt = new Date('2026-11-22T12:00:00.000Z')
const text = (name: string) => ({ name, json: [{ name, value: `data of ${name}` }] })
const sha = (bytes: Uint8Array | string): string => createHash('sha256').update(bytes).digest('hex')

async function drain(result: { stream: Readable }): Promise<Buffer> {
  const stream = result.stream
  const chunks: Buffer[] = []
  for await (const chunk of stream) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks)
}
const sourceOf = (
  objects: Record<string, Buffer | Error>
): DsrFileSource & { opened: string[] } => {
  const opened: string[] = []
  return {
    opened,
    stream: key => {
      opened.push(key)
      const object = objects[key]
      if (object === undefined) return Promise.resolve(null)
      if (object instanceof Error) {
        return Promise.resolve(
          new Readable({
            read() {
              this.destroy(object)
            }
          })
        )
      }
      return Promise.resolve(Readable.from([object], { objectMode: false }))
    }
  }
}
const PASSWORD = randomBytes(24).toString('base64url')
// Reads the ZIP with the password, as any tool that opens a ZIP with AES-256 would
async function unzip(
  zip: Buffer,
  password: string | null = PASSWORD
): Promise<Record<string, Uint8Array>> {
  const reader = new ZipReader(new BlobReader(new Blob([new Uint8Array(zip)])), {
    password: password ?? undefined
  })
  const out: Record<string, Uint8Array> = {}
  for (const entry of await reader.getEntries()) {
    if (!entry.directory) out[entry.filename] = await entry.getData(new Uint8ArrayWriter())
  }
  await reader.close()
  return out
}
const run = (input: DsrExportContent, source: DsrFileSource, password: string = PASSWORD) =>
  streamDsrZip(input, { type: 'access', generatedAt }, source, password)

describe('the streamed ZIP of a data export', () => {
  const bytesA = Buffer.from('the picture of a receipt'.repeat(500))
  const bytesB = Buffer.from([0, 1, 2, 3, 250, 251])
  const content = (): DsrExportContent => ({
    files: [text('customers.json'), text('files.json')],
    counts: { customers: 1, files: 2 },
    attachments: [
      {
        entry: dsrFileEntryName(0, 'receipt.png'),
        key: 'stores/s1/m/1/receipt.png',
        size: bytesA.length
      },
      {
        entry: dsrFileEntryName(1, 'voice.ogg'),
        key: 'stores/s1/m/2/voice.ogg',
        size: bytesB.length
      }
    ]
  })
  const objects = { 'stores/s1/m/1/receipt.png': bytesA, 'stores/s1/m/2/voice.ogg': bytesB }

  it('holds the text, the files byte for byte, and a manifest whose hashes are those of every entry', async () => {
    const zip = await drain(run(content(), sourceOf(objects)))

    const entries = await unzip(zip)
    expect(Object.keys(entries).sort()).toEqual(
      ['customers.json', 'files.json', 'files/0000.png', 'files/0001.ogg', 'manifest.json'].sort()
    )
    expect(Buffer.from(entries['files/0000.png'] ?? []).equals(bytesA)).toBe(true)
    expect(Buffer.from(entries['files/0001.ogg'] ?? []).equals(bytesB)).toBe(true)
    const manifest = JSON.parse(Buffer.from(entries['manifest.json'] ?? []).toString('utf8')) as {
      type: string
      files: { name: string; sha256: string; bytes: number }[]
      notIncluded: string[]
      counts: Record<string, number>
    }
    expect(manifest.type).toBe('access')
    expect(manifest.counts).toEqual({ customers: 1, files: 2 })
    expect(manifest.files.map(file => file.name).sort()).toEqual(
      ['customers.json', 'files.json', 'files/0000.png', 'files/0001.ogg'].sort()
    )
    for (const file of manifest.files) {
      expect(file.sha256).toBe(sha(entries[file.name] ?? new Uint8Array()))
      expect(file.bytes).toBe((entries[file.name] ?? new Uint8Array()).length)
    }
    // The manifest says what is left out, and a file is no longer one of the things left out
    expect(manifest.notIncluded.join(' ')).toMatch(/internal notes/)
    expect(manifest.notIncluded.join(' ')).not.toMatch(/the files themselves/)
  })

  it('is encrypted: no text of the person, no name of a file, no listed hash is in the bytes, and it does not open without the password', async () => {
    const zip = await drain(run(content(), sourceOf(objects)))

    for (const needle of ['data of customers.json', 'receipt', 'voice', 'sha256']) {
      expect(zip.includes(Buffer.from(needle))).toBe(false)
    }
    expect(zip.includes(bytesA.subarray(0, 24))).toBe(false)
    // Only the numbered names are in the open
    expect(zip.includes(Buffer.from('files/0000.png'))).toBe(true)
    await expect(unzip(zip, null)).rejects.toThrow()
    await expect(unzip(zip, 'a-wrong-password')).rejects.toThrow()
    expect(Object.keys(await unzip(zip)).length).toBe(5)
  })

  it('refuses a ZIP whose encrypted bytes were altered, and gives nothing of its content', async () => {
    const zip = await drain(run(content(), sourceOf(objects)))
    // Flip a byte in the middle of the data of the first entry (past its local header, its salt and its check value)
    const altered = Buffer.from(zip)
    const at = altered.indexOf(Buffer.from('customers.json')) + 'customers.json'.length + 64
    altered[at] = (altered[at] ?? 0) ^ 0xff

    await expect(unzip(altered)).rejects.toThrow()
  })

  it('tears the whole pipeline down, and opens no further file, when the reader abandons the stream', async () => {
    const source = sourceOf(objects)
    const result = run(content(), source)
    result.stream.destroy()
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(source.opened.length).toBeLessThanOrEqual(2)
  })

  it('does not let the password out in an error', async () => {
    const failure = await drain(run(content(), sourceOf({}))).catch((error: unknown) => error)
    expect(String(failure)).not.toContain(PASSWORD)
  })

  it('refuses a password that is too short to be one made for the export', () => {
    expect(() => run(content(), sourceOf(objects), 'short')).toThrow()
  })

  it('keeps the same data but not the same bytes for two exports with one password (a new salt and nonce each time)', async () => {
    const first = await drain(run(content(), sourceOf(objects)))
    const second = await drain(run(content(), sourceOf(objects)))
    expect(first.equals(second)).toBe(false)
  })

  it('opens a file only when the ZIP reaches it, and never one that is not in the list', async () => {
    const source = sourceOf({
      ...objects,
      'stores/other/m/9/secret.png': Buffer.from('not theirs')
    })
    const zip = await drain(run(content(), source))

    expect(source.opened.sort()).toEqual(['stores/s1/m/1/receipt.png', 'stores/s1/m/2/voice.ogg'])
    expect(JSON.stringify(Object.keys(await unzip(zip)))).not.toContain('secret')
  })

  it('stops at the byte limit of the whole ZIP while it streams, instead of cutting the file or holding it', async () => {
    const limit = jest.replaceProperty(ComplianceConfig, 'DSR_EXPORT_MAX_ZIP_BYTES', 64 * 1024)
    // Random bytes do not compress: the ZIP is as big as the file. The limit is on the bytes that come out of the ZIP
    const body = randomBytes(256 * 1024)
    const input: DsrExportContent = {
      files: [text('customers.json')],
      counts: {},
      attachments: [{ entry: dsrFileEntryName(0, 'big.bin'), key: 'k', size: body.length }]
    }

    await expect(drain(run(input, sourceOf({ k: body })))).rejects.toBeInstanceOf(
      DsrExportTooLargeError
    )
    limit.restore()
  })

  it('fails the whole ZIP when a listed file is gone or cannot be read, never ships a hole', async () => {
    await expect(
      drain(run(content(), sourceOf({ 'stores/s1/m/1/receipt.png': bytesA })))
    ).rejects.toThrow('not in the bucket')
    await expect(
      drain(
        run(
          content(),
          sourceOf({ ...objects, 'stores/s1/m/2/voice.ogg': new Error('socket reset') })
        )
      )
    ).rejects.toThrow()
  })

  it('fails when a file ends short of the size the bucket reported, instead of shipping a smaller file', async () => {
    const short: DsrExportContent = {
      ...content(),
      attachments: [
        {
          entry: dsrFileEntryName(0, 'a.png'),
          key: 'stores/s1/m/1/receipt.png',
          size: bytesA.length + 1
        }
      ]
    }

    await expect(drain(run(short, sourceOf(objects)))).rejects.toThrow('not the size')
  })

  it('refuses text past the byte limit instead of cutting it', () => {
    const big = 'x'.repeat(1024 * 1024)
    const rows = Array.from(
      { length: Math.ceil(ComplianceConfig.DSR_EXPORT_MAX_BYTES / big.length) + 1 },
      () => big
    )
    expect(() =>
      run(
        { files: [{ name: 'messages.json', json: rows }], counts: {}, attachments: [] },
        sourceOf({})
      )
    ).toThrow(DsrExportTooLargeError)
  })
})

describe('the name of a file inside the ZIP', () => {
  it.each([
    ['../../etc/passwd', 'files/0003'],
    ['a\\b/c d.png', 'files/0003.png'],
    ['', 'files/0003'],
    ['\u0000‮.exe', 'files/0003.exe'],
    ['Resume_Juan_Perez.PDF', 'files/0003.pdf'],
    ['archive.tar.gz', 'files/0003.gz'],
    ['x.p/ng', 'files/0003']
  ])(
    'holds the number and at most a short extension, never the name or a path: %j',
    (filename, expected) => {
      const name = dsrFileEntryName(3, filename)
      expect(name).toBe(expected)
      expect([...name.slice('files/'.length)].every(char => /[A-Za-z0-9.]/.test(char))).toBe(true)
    }
  )

  it('keeps names short and distinct for the same filename', () => {
    const long = `${'n'.repeat(500)}.png`
    expect(dsrFileEntryName(1, long).length).toBeLessThan(40)
    expect(dsrFileEntryName(1, 'a.png')).not.toBe(dsrFileEntryName(2, 'a.png'))
  })
})
