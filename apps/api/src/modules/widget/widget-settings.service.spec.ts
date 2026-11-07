import type { PinoLogger } from 'nestjs-pino'

import type { AuditService } from '@platform/core/audit-module'
import type { PrismaService } from '@platform/core/database'
import { ConnectSrcProbe } from '@platform/core/domain'
import type { StorageService } from '@platform/core/storage-module'

import { WidgetSettings } from './widget-settings.service'

const BUCKET = 'https://bucket.test'

describe('WidgetSettings connectSrc', () => {
  let uploadUrl: jest.Mock
  let warn: jest.Mock
  let settings: WidgetSettings
  let config: { apiUrl: string; scriptUrl: string }

  beforeEach(() => {
    uploadUrl = jest.fn()
    warn = jest.fn()
    config = { apiUrl: 'https://api.example.test', scriptUrl: 'https://cdn.example.test/widget.js' }
    const prisma = {
      client: {
        channelConnection: {
          findFirst: jest.fn().mockResolvedValue({
            connectionId: 'conn-1',
            status: 'ACTIVE',
            metadata: {}
          })
        }
      }
    }
    settings = new WidgetSettings(
      prisma as unknown as PrismaService,
      config,
      { log: jest.fn() } as unknown as AuditService,
      { uploadUrl } as unknown as StorageService,
      { setContext: jest.fn(), warn } as unknown as PinoLogger
    )
  })

  it('lists the api, its socket and the bucket origin, cut from the signed url', async () => {
    uploadUrl.mockResolvedValue(`${BUCKET}/k?X-Amz-Signature=abc`)
    const view = await settings.embed('store-1', 'conn-1')
    expect(view.connectSrc).toEqual(['https://api.example.test', 'wss://api.example.test', BUCKET])
    expect(uploadUrl).toHaveBeenCalledWith(expect.objectContaining({ key: ConnectSrcProbe.KEY }))
  })

  it('lists the origin of the script, without its path', async () => {
    uploadUrl.mockResolvedValue(`${BUCKET}/k`)
    const view = await settings.embed('store-1', 'conn-1')
    expect(view.scriptSrc).toEqual(['https://cdn.example.test'])
  })

  it('leaves the bucket out and logs when signing fails, without breaking the read', async () => {
    uploadUrl.mockRejectedValue(new Error('no credentials'))
    const view = await settings.embed('store-1', 'conn-1')
    expect(view.connectSrc).toEqual(['https://api.example.test', 'wss://api.example.test'])
    expect(view.snippet).toContain('data-site-key="conn-1"')
    expect(warn).toHaveBeenCalledTimes(1)
  })

  it('uses ws for the socket of an api served over http', async () => {
    config.apiUrl = 'http://localhost:8080'
    uploadUrl.mockResolvedValue(`${BUCKET}/k`)
    const view = await settings.embed('store-1', 'conn-1')
    expect(view.connectSrc).toEqual(['http://localhost:8080', 'ws://localhost:8080', BUCKET])
  })

  it('leaves the bucket out when the signed url cannot be read', async () => {
    uploadUrl.mockResolvedValue('not a url')
    const view = await settings.embed('store-1', 'conn-1')
    expect(view.connectSrc).toEqual(['https://api.example.test', 'wss://api.example.test'])
    expect(warn).toHaveBeenCalledTimes(1)
  })

  it('leaves the bucket out when the signer throws at once or gives a url with no origin', async () => {
    uploadUrl.mockImplementation(() => {
      throw new Error('sync')
    })
    const thrown = await settings.embed('store-1', 'conn-1')
    expect(thrown.connectSrc).toEqual(['https://api.example.test', 'wss://api.example.test'])
    uploadUrl.mockReset().mockResolvedValue('data:text/plain,x')
    const opaque = await settings.embed('store-1', 'conn-1')
    expect(opaque.connectSrc).not.toContain('null')
    expect(warn).toHaveBeenCalledTimes(2)
  })

  it('does not keep a failure: the next read signs again and gets the bucket', async () => {
    uploadUrl.mockRejectedValueOnce(new Error('boom')).mockResolvedValue(`${BUCKET}/k?s=1`)
    await settings.embed('store-1', 'conn-1')
    const view = await settings.embed('store-1', 'conn-1')
    expect(view.connectSrc).toContain(BUCKET)
    expect(uploadUrl).toHaveBeenCalledTimes(2)
  })
})
