import { z } from 'zod'

import { ErrorCodes, PlatformException } from '@platform/core/errors'

import { ZodValidationPipe } from './zod-validation.pipe'

const schema = z.object({ email: z.email(), minutes: z.number().int().positive() })
const pipe = new ZodValidationPipe(schema)

function failureOf(
  value: unknown,
  using: { transform(value: unknown): unknown } = pipe
): PlatformException {
  try {
    using.transform(value)
  } catch (error) {
    if (error instanceof PlatformException) return error
  }
  throw new Error('the pipe accepted the value')
}

describe('ZodValidationPipe', () => {
  it('returns the parsed value, with what the schema transforms', () => {
    const trimmed = new ZodValidationPipe(z.object({ email: z.string().trim().toLowerCase() }))

    expect(trimmed.transform({ email: '  Person@Example.com ' })).toEqual({
      email: 'person@example.com'
    })
    expect(pipe.transform({ email: 'a@b.co', minutes: 5 })).toEqual({ email: 'a@b.co', minutes: 5 })
  })

  it('drops the fields the schema does not know', () => {
    expect(pipe.transform({ email: 'a@b.co', minutes: 5, admin: true })).toEqual({
      email: 'a@b.co',
      minutes: 5
    })
  })

  it('refuses with a 400 and the contract code, naming the fields', () => {
    const error = failureOf({ email: 'not-an-email', minutes: -1 })

    expect(error.code).toBe(ErrorCodes.VALIDATION_FAILED)
    expect(error.statusCode).toBe(400)
    expect(error.metadata).toEqual({
      issues: [
        expect.objectContaining({ path: 'email', code: 'invalid_format' }),
        expect.objectContaining({ path: 'minutes', code: 'too_small' })
      ],
      truncated: false
    })
  })

  it('never repeats the value that was sent', () => {
    const error = failureOf({ email: 'secret-value@@', minutes: 5 })

    expect(JSON.stringify(error.metadata)).not.toContain('secret-value')
  })

  it('reports at most 20 problems, and says when there were more', () => {
    const wide = new ZodValidationPipe(z.record(z.string(), z.number()))
    const body = Object.fromEntries(Array.from({ length: 500 }, (_unused, i) => [`field${i}`, 'x']))

    const error = failureOf(body, wide)

    const metadata = error.metadata as { issues: unknown[]; truncated: boolean }
    expect(metadata.issues).toHaveLength(20)
    expect(metadata.truncated).toBe(true)
  })

  it.each([null, undefined, 'text', 42, []])('refuses %j as a body', value => {
    expect(failureOf(value).statusCode).toBe(400)
  })
})
