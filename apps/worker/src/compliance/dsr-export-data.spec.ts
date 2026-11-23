import { createHash } from 'node:crypto'

import { unzipSync } from 'fflate'

import { ComplianceConfig } from '@platform/core/compliance'

import { DsrExportTooLargeError, zipDsrExport } from './dsr-export-data'

const files = (names: string[]) =>
  names.map(name => ({ name, json: [{ name, value: `data of ${name}` }] }))
const read = (zip: Buffer): Record<string, string> =>
  Object.fromEntries(
    Object.entries(unzipSync(new Uint8Array(zip))).map(([name, bytes]) => [
      name,
      Buffer.from(bytes).toString('utf8')
    ])
  )

describe('the ZIP of a data export', () => {
  const generatedAt = new Date('2026-11-22T12:00:00.000Z')

  it('holds every file and a manifest whose hashes are those of the files, and says what is not included', async () => {
    const zip = await zipDsrExport(
      { files: files(['customers.json', 'orders.json']), counts: { customers: 1, orders: 3 } },
      { type: 'access', generatedAt }
    )

    const content = read(zip)
    expect(Object.keys(content).sort()).toEqual(['customers.json', 'manifest.json', 'orders.json'])
    const manifest = JSON.parse(content['manifest.json'] ?? '') as {
      type: string
      generatedAt: string
      counts: Record<string, number>
      files: { name: string; sha256: string }[]
      notIncluded: string[]
    }
    expect(manifest).toMatchObject({
      type: 'access',
      generatedAt: generatedAt.toISOString(),
      counts: { customers: 1, orders: 3 }
    })
    for (const file of manifest.files) {
      const hash = createHash('sha256')
        .update(content[file.name] ?? '', 'utf8')
        .digest('hex')
      expect(file.sha256).toBe(hash)
    }
    expect(manifest.notIncluded.join(' ')).toMatch(/internal notes/)
  })

  it('refuses text past the byte limit instead of cutting it', async () => {
    const big = 'x'.repeat(1024 * 1024)
    const rows = Array.from(
      { length: Math.ceil(ComplianceConfig.DSR_EXPORT_MAX_BYTES / big.length) + 1 },
      () => big
    )

    await expect(
      zipDsrExport(
        { files: [{ name: 'messages.json', json: rows }], counts: {} },
        { type: 'access', generatedAt }
      )
    ).rejects.toBeInstanceOf(DsrExportTooLargeError)
  })
})
