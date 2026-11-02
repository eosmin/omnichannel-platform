import { formatBytes, putFile, refuseFile } from './upload'

describe('refuseFile', () => {
  it('takes an allowed type within its size', () => {
    expect(refuseFile({ type: 'image/png', size: 1000 })).toBeNull()
  })

  it('refuses an empty file, a type the api does not take and a file that is too large', () => {
    expect(refuseFile({ type: 'image/png', size: 0 })).toBe('empty')
    expect(refuseFile({ type: '', size: 10 })).toBe('type')
    expect(refuseFile({ type: 'application/x-msdownload', size: 10 })).toBe('type')
    expect(refuseFile({ type: 'image/png', size: 11 * 1024 * 1024 })).toBe('size')
  })

  it('lets a video be larger than other files', () => {
    expect(refuseFile({ type: 'video/mp4', size: 20 * 1024 * 1024 })).toBeNull()
  })
})

describe('formatBytes', () => {
  it('writes a size in the unit that fits', () => {
    expect(formatBytes(500)).toBe('500 B')
    expect(formatBytes(1536)).toBe('1.5 KB')
    expect(formatBytes(1048575)).toBe('1.0 MB')
    expect(formatBytes(10 * 1024 * 1024)).toBe('10 MB')
  })
})

describe('putFile', () => {
  class FakeRequest {
    static last: FakeRequest
    status = 200
    upload: { onprogress?: (event: unknown) => void } = {}
    onload?: () => void
    onerror?: () => void
    ontimeout?: () => void
    onabort?: () => void
    timeout = 0
    headers: Record<string, string> = {}
    method = ''
    url = ''
    sent: unknown
    constructor() {
      FakeRequest.last = this
    }
    open(method: string, url: string): void {
      this.method = method
      this.url = url
    }
    setRequestHeader(name: string, value: string): void {
      this.headers[name] = value
    }
    send(body: unknown): void {
      this.sent = body
    }
  }
  const original = globalThis.XMLHttpRequest
  beforeEach(() => {
    Object.defineProperty(globalThis, 'XMLHttpRequest', { value: FakeRequest, configurable: true })
  })
  afterEach(() => {
    Object.defineProperty(globalThis, 'XMLHttpRequest', { value: original, configurable: true })
  })

  it('puts the file with the signed type and reports the progress', async () => {
    const blob = new Blob(['x'])
    const progress = jest.fn()

    const done = putFile('https://bucket.test/k', blob, 'image/png', progress)
    FakeRequest.last.upload.onprogress?.({ lengthComputable: true, loaded: 1, total: 4 })
    FakeRequest.last.onload?.()
    await done

    expect(progress).toHaveBeenCalledWith(0.25)
    expect(FakeRequest.last).toMatchObject({
      method: 'PUT',
      url: 'https://bucket.test/k',
      headers: { 'content-type': 'image/png' },
      sent: blob
    })
  })

  it('fails when the upload times out or is aborted', async () => {
    const slow = putFile('u', new Blob(['x']), 'image/png', jest.fn())
    expect(FakeRequest.last.timeout).toBeGreaterThan(0)
    FakeRequest.last.ontimeout?.()
    await expect(slow).rejects.toThrow('timed out')

    const stopped = putFile('u', new Blob(['x']), 'image/png', jest.fn())
    FakeRequest.last.onabort?.()
    await expect(stopped).rejects.toThrow('aborted')
  })

  it('fails when the bucket refuses or cannot be reached', async () => {
    const refused = putFile('u', new Blob(['x']), 'image/png', jest.fn())
    FakeRequest.last.status = 403
    FakeRequest.last.onload?.()
    await expect(refused).rejects.toThrow('403')

    const down = putFile('u', new Blob(['x']), 'image/png', jest.fn())
    FakeRequest.last.onerror?.()
    await expect(down).rejects.toThrow()
  })
})
