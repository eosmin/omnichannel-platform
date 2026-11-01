import { Readable } from 'node:stream'

import type { PinoLogger } from 'nestjs-pino'

import type { StorageService } from '@platform/core/storage-module'

import type { ZipEntry, ZipSource } from './media-zip-export.source'
import { ZipExportWriter } from './zip-export-writer'

const entry = (key: string, filename: string): ZipEntry => ({
  key,
  filename,
  contentType: 'image/png',
  modifiedAt: new Date('2026-11-01T00:00:00Z')
})

function build(present: Set<string>): { writer: ZipExportWriter; written: () => Buffer } {
  const chunks: Buffer[] = []
  const storage = {
    putStream: async (_key: string, body: Readable): Promise<void> => {
      for await (const chunk of body) chunks.push(chunk as Buffer)
    },
    stream: (key: string) =>
      Promise.resolve(present.has(key) ? Readable.from([Buffer.from(key)]) : null)
  }
  const logger = { setContext: jest.fn(), warn: jest.fn(), error: jest.fn() }
  return {
    writer: new ZipExportWriter(
      storage as unknown as StorageService,
      logger as unknown as PinoLogger
    ),
    written: () => Buffer.concat(chunks)
  }
}

const sourceOf = (...files: [string, string][]): ZipSource => ({
  entries: () => Readable.from(files.map(([key, filename]) => entry(key, filename))) as never
})

describe('ZipExportWriter', () => {
  it('lists the files that were gone from the bucket in missing.txt', async () => {
    const { writer, written } = build(new Set(['k1']))
    const result = await writer.write('out', sourceOf(['k1', 'a.png'], ['k2', 'lost.png']))

    expect(result.rowCount).toBe(1)
    const text = written().toString('latin1')
    expect(text).toContain('missing.txt')
    expect(text).toContain('lost.png\n')
  })

  it('adds no missing.txt when every file was there', async () => {
    const { writer, written } = build(new Set(['k1']))
    await writer.write('out', sourceOf(['k1', 'a.png']))
    expect(written().toString('latin1')).not.toContain('missing.txt')
  })

  it('numbers a customer file called missing.txt instead of the report', async () => {
    const { writer, written } = build(new Set(['k1']))
    await writer.write('out', sourceOf(['k1', 'missing.txt'], ['k2', 'lost.png']))
    const text = written().toString('latin1')
    expect(text).toContain('missing (2).txt')
  })
})
