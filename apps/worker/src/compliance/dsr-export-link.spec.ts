import { hashToken } from '@platform/core/crypto'
import type { PrismaTransaction } from '@platform/core/database'

import { dsrExportLinkOf } from './dsr-export-link'

const FUTURE = new Date(Date.now() + 86_400_000)
const base = {
  requestId: 'req-1',
  requestType: 'access',
  fileExpiresAt: FUTURE,
  frontendUrl: 'http://web.test'
}

function build(spent: number) {
  const count = jest.fn().mockResolvedValue(spent)
  const create = jest.fn().mockResolvedValue({})
  const tx = { verificationToken: { count, create } } as unknown as PrismaTransaction
  return { tx, count, create }
}

describe('dsrExportLinkOf', () => {
  it('mints a token whose hash is stored until the file expires, and puts the token in the fragment only', async () => {
    const { tx, create } = build(0)
    const { downloadUrl } = await dsrExportLinkOf(tx, base)
    const url = new URL(downloadUrl ?? 'invalid:')
    expect(url.origin + url.pathname).toBe('http://web.test/compliance/dsr/export')
    expect(url.search).toBe('')
    const token = new URLSearchParams(url.hash.slice(1)).get('token') ?? ''
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(create).toHaveBeenCalledWith({
      data: {
        type: 'dsr_export_download',
        tokenHash: hashToken(token),
        subject: 'req-1',
        expiresAt: FUTURE
      }
    })
    expect(JSON.stringify(create.mock.calls)).not.toContain(token)
  })

  it('gives no link and writes no token when the file was already downloaded (the notice asked for again)', async () => {
    const { tx, create } = build(1)
    await expect(dsrExportLinkOf(tx, base)).resolves.toEqual({})
    expect(create).not.toHaveBeenCalled()
  })

  it.each([
    ['an erasure', { requestType: 'erasure' }],
    ['a file with no date (purged)', { fileExpiresAt: null }],
    ['a file past its date', { fileExpiresAt: new Date(Date.now() - 1000) }]
  ])('gives no link and writes no token for %s', async (_name, change) => {
    const { tx, count, create } = build(0)
    await expect(dsrExportLinkOf(tx, { ...base, ...change })).resolves.toEqual({})
    expect(count).not.toHaveBeenCalled()
    expect(create).not.toHaveBeenCalled()
  })

  it('serves a portability request too', async () => {
    const { tx } = build(0)
    expect(
      (await dsrExportLinkOf(tx, { ...base, requestType: 'portability' })).downloadUrl
    ).toBeDefined()
  })
})
