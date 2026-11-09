import { parseToyEnabled } from './toy-env'

describe('the toy channel switch', () => {
  it('is off unless the environment says 1', () => {
    expect(parseToyEnabled({ NODE_ENV: 'test' })).toBe(false)
    expect(parseToyEnabled({ NODE_ENV: 'development' })).toBe(false)
    expect(parseToyEnabled({ NODE_ENV: 'test', E2E_TOY_PLUGIN: '1' })).toBe(true)
  })

  it('refuses any other value', () => {
    expect(() => parseToyEnabled({ NODE_ENV: 'test', E2E_TOY_PLUGIN: 'true' })).toThrow()
  })

  it.each(['development', 'production', 'staging'])(
    'refuses to boot in %s with the switch on',
    env => {
      expect(() => parseToyEnabled({ NODE_ENV: env, E2E_TOY_PLUGIN: '1' })).toThrow(
        /NODE_ENV=test only/
      )
    }
  )
})
