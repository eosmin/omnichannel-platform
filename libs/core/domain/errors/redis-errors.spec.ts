import { isRedisUnavailableError } from './redis-errors'

class MaxRetriesPerRequestError extends Error {
  override name = 'MaxRetriesPerRequestError'
}

describe('isRedisUnavailableError', () => {
  it.each([
    ['the retries of the client ran out', new MaxRetriesPerRequestError('Reached the max retries')],
    ['the command timed out', new Error('Command timed out')],
    ['the connection is closed', new Error('Connection is closed.')],
    ['an error that wraps one of them', { cause: new Error('Command timed out') }]
  ])('is true when %s', (_name, error) => {
    expect(isRedisUnavailableError(error)).toBe(true)
  })

  it.each([
    ['a plain bug', new TypeError('x is not a function')],
    ['a message that only contains the text', new Error('Command timed out for customer Ana')],
    ['a database error', { code: 'P2010' }],
    [
      'a refused connection of another dependency',
      Object.assign(new Error('connect'), { code: 'ECONNREFUSED' })
    ],
    [
      'an aborted outbound call',
      Object.assign(new Error('The operation was aborted'), { name: 'AbortError' })
    ],
    ['a string', 'Command timed out'],
    ['nothing', undefined]
  ])('is false for %s', (_name, error) => {
    expect(isRedisUnavailableError(error)).toBe(false)
  })

  it('stops on a cycle', () => {
    const loop: Record<string, unknown> = {}
    loop['cause'] = loop
    expect(isRedisUnavailableError(loop)).toBe(false)
  })
})
