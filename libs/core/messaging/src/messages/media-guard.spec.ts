import { ErrorCodes, HttpStatusCodes, PlatformException } from '@platform/core/errors'
import { AvSanitizing } from '@platform/core/storage'

import {
  assertMediaSendable,
  assertMediaServable,
  isKeptWithMetadata,
  isReadyToSend
} from './media-guard'

function refusal(status: string): PlatformException {
  try {
    assertMediaServable(status)
  } catch (error) {
    if (error instanceof PlatformException) return error
    throw error
  }
  throw new Error(`"${status}" was not refused`)
}

describe('assertMediaServable', () => {
  it('lets a clean file through', () => {
    expect(() => assertMediaServable('clean')).not.toThrow()
  })

  it.each([
    ['infected', ErrorCodes.FILE_INFECTED, HttpStatusCodes.FORBIDDEN],
    ['unscannable', ErrorCodes.FILE_UNSCANNABLE, HttpStatusCodes.GONE],
    ['pending', ErrorCodes.FILE_NOT_READY, HttpStatusCodes.CONFLICT],
    ['a status nobody knows', ErrorCodes.FILE_NOT_READY, HttpStatusCodes.CONFLICT]
  ])('refuses %s with its own code and status', (status, code, httpStatus) => {
    const error = refusal(status)
    expect(error.code).toBe(code)
    expect(error.statusCode).toBe(httpStatus)
  })
})

function sendRefusal(row: {
  status: string
  contentType?: string
  scanResult: unknown
}): PlatformException {
  try {
    assertMediaSendable({ contentType: 'image/png', ...row })
  } catch (error) {
    if (error instanceof PlatformException) return error
    throw error
  }
  throw new Error('the file was not refused')
}

describe('assertMediaSendable', () => {
  const cleaned = { sanitized: true, [AvSanitizing.CLEANING_VERSION_KEY]: 1 }

  it.each([
    ['a file cleaned of its metadata', cleaned],
    ['a file with no scan result (an image or a document)', null],
    ['a file whose scan result is not an object', 'x'],
    ['an image with the mark of the picture sweep', { sanitizeSweep: 'not_cleanable' }]
  ])('lets %s through', (_name, scanResult) => {
    expect(() =>
      assertMediaSendable({ status: 'clean', contentType: 'image/png', scanResult })
    ).not.toThrow()
  })

  it.each([
    [AvSanitizing.Untouched.NOT_CLEANABLE],
    [AvSanitizing.Untouched.TOO_LARGE],
    [AvSanitizing.Untouched.TIMED_OUT],
    [AvSanitizing.Untouched.TYPE],
    [AvSanitizing.Outcomes.AV_UNAVAILABLE]
  ])('refuses a clean file kept as it came (%s) with its metadata', reason => {
    const error = sendRefusal({
      status: 'clean',
      scanResult: { [AvSanitizing.OUTCOME_KEY]: reason, [AvSanitizing.CLEANING_VERSION_KEY]: 1 }
    })
    expect(error.code).toBe(ErrorCodes.FILE_UNAVAILABLE)
    expect(error.statusCode).toBe(HttpStatusCodes.CONFLICT)
  })

  it('refuses any mark of a kept file, whatever its value', () => {
    const error = sendRefusal({ status: 'clean', scanResult: { [AvSanitizing.OUTCOME_KEY]: '' } })
    expect(error.code).toBe(ErrorCodes.FILE_UNAVAILABLE)
  })

  it('still refuses a file that is not clean with the code of its status, before the mark', () => {
    const kept = { [AvSanitizing.OUTCOME_KEY]: AvSanitizing.Untouched.NOT_CLEANABLE }
    expect(sendRefusal({ status: 'pending', scanResult: kept }).code).toBe(
      ErrorCodes.FILE_NOT_READY
    )
    expect(sendRefusal({ status: 'infected', scanResult: kept }).code).toBe(
      ErrorCodes.FILE_INFECTED
    )
  })
})

describe('isKeptWithMetadata', () => {
  it('is true only for a scan result that carries the mark of a kept file', () => {
    expect(isKeptWithMetadata({ [AvSanitizing.OUTCOME_KEY]: 'cover_kept' })).toBe(true)
    expect(isKeptWithMetadata({ sanitized: true })).toBe(false)
    expect(isKeptWithMetadata(null)).toBe(false)
    expect(isKeptWithMetadata(undefined)).toBe(false)
    expect(isKeptWithMetadata([AvSanitizing.OUTCOME_KEY])).toBe(false)
  })
})

describe('isReadyToSend for video and audio', () => {
  const cleaned = { sanitized: true, [AvSanitizing.CLEANING_VERSION_KEY]: 1 }

  it.each(['video/mp4', 'audio/ogg'])(
    'lets %s through only with the mark of the cleaning',
    type => {
      expect(isReadyToSend({ contentType: type, scanResult: cleaned })).toBe(true)
    }
  )

  it.each([
    ['no scan result (uploaded before the cleaning existed)', null],
    ['a scan result of something else', {}],
    ['a sweep that has not finished', { avSweepAttempts: 1 }],
    ['the mark with another value', { sanitized: 'true' }],
    ['a scan result that is not an object', 'x']
  ])('refuses a video or audio file with %s', (_name, scanResult) => {
    expect(isReadyToSend({ contentType: 'video/mp4', scanResult })).toBe(false)
    expect(isReadyToSend({ contentType: 'audio/ogg', scanResult })).toBe(false)
  })

  it('refuses a cleaned mark that also says the file was kept', () => {
    expect(
      isReadyToSend({
        contentType: 'video/mp4',
        scanResult: { ...cleaned, [AvSanitizing.OUTCOME_KEY]: 'cover_kept' }
      })
    ).toBe(false)
  })

  it('does not ask a picture or a document for the mark', () => {
    expect(isReadyToSend({ contentType: 'image/png', scanResult: null })).toBe(true)
    expect(isReadyToSend({ contentType: 'application/pdf', scanResult: null })).toBe(true)
  })
})
