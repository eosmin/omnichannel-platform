import { ErrorCodes, HttpStatusCodes, PlatformException } from '@platform/core/errors'

import { RejectNulPipe } from './reject-nul.pipe'

const pipe = new RejectNulPipe()

function refusal(
  value: unknown,
  type: 'body' | 'query' | 'param',
  data?: string
): PlatformException {
  try {
    pipe.transform(value, { type, data })
  } catch (error) {
    if (error instanceof PlatformException) return error
  }
  throw new Error('the pipe accepted the value')
}

describe('RejectNulPipe', () => {
  it('answers 400 to a NUL in a path parameter, and names the parameter, not the value', () => {
    const error = refusal('a\0b', 'param', 'pluginId')

    expect(error.statusCode).toBe(HttpStatusCodes.BAD_REQUEST)
    expect(error.code).toBe(ErrorCodes.VALIDATION_FAILED)
    expect(JSON.stringify(error.metadata)).toBe('{"in":"param","field":"pluginId"}')
  })

  it('refuses a NUL deep in a body and in the query', () => {
    expect(refusal({ events: [{ message: { content: 'x\0' } }] }, 'body').code).toBe(
      ErrorCodes.VALIDATION_FAILED
    )
    expect(refusal({ q: 'x\0' }, 'query').code).toBe(ErrorCodes.VALIDATION_FAILED)
  })

  it('returns the very same value when there is no NUL', () => {
    const body = { name: 'Ana', tags: ['a', 'b'] }

    expect(pipe.transform(body, { type: 'body' })).toBe(body)
    expect(pipe.transform('plugin-id', { type: 'param', data: 'id' })).toBe('plugin-id')
  })

  it('leaves a custom argument alone', () => {
    const file = 'x\0'

    expect(pipe.transform(file, { type: 'custom' })).toBe(file)
  })
})
