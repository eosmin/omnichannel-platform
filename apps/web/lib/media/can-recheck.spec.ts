import { ClientErrorCodes } from '@platform/core/errors'

import { canRecheck } from './can-recheck'

describe('canRecheck', () => {
  const stuck = { status: 'failed', mediaId: 'm1', code: ClientErrorCodes.FILE_NOT_READY }

  it('is true for a stored file whose asking ran out', () => {
    expect(canRecheck(stuck)).toBe(true)
  })

  it('is false while the file is still being asked about or is ready', () => {
    expect(canRecheck({ ...stuck, status: 'checking' })).toBe(false)
    expect(canRecheck({ ...stuck, status: 'ready' })).toBe(false)
  })

  it('is false when the file never reached the bucket', () => {
    expect(canRecheck({ ...stuck, mediaId: null })).toBe(false)
  })

  it('is false for a file that was refused or infected', () => {
    expect(canRecheck({ ...stuck, code: ClientErrorCodes.FILE_UPLOAD_FAILED })).toBe(false)
    expect(canRecheck({ ...stuck, code: null })).toBe(false)
  })
})
