import { ClientErrorCodes } from './client-error-codes'
import { ErrorCodes } from './error-codes'

// The browser holds a short copy of the table; it must not drift from the real one
describe('ClientErrorCodes', () => {
  it.each(Object.entries(ClientErrorCodes))(
    '%s is a code the api can send, spelled the same',
    (key, value) => {
      expect(key).toBe(value)
      expect(Object.values(ErrorCodes)).toContain(value)
      expect(ErrorCodes[key as keyof typeof ErrorCodes]).toBe(value)
    }
  )
})
