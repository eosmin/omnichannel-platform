import { DevService, devServiceEnv } from './dev-services'

const BASE = {
  DATABASE_URL: 'postgresql://platform_app:dev_app_password@localhost:6432/platform_dev',
  DB_WORKER_PASSWORD: 'dev_worker_password',
  PORT: '8080'
}

describe('devServiceEnv', () => {
  it('leaves the api exactly as the env files say', () => {
    expect(devServiceEnv(DevService.API, BASE)).toEqual({})
  })

  it('gives the worker its own role, its own port and the worker role of the app', () => {
    const env = devServiceEnv(DevService.WORKER, BASE)
    expect(env['APP_ROLE']).toBe('worker')
    expect(env['PORT']).toBe('8081')
    const url = new URL(env['DATABASE_URL'] ?? '')
    expect(url.username).toBe('platform_worker')
    expect(url.password).toBe('dev_worker_password')
    expect(url.hostname).toBe('localhost')
    expect(url.port).toBe('6432')
    expect(url.pathname).toBe('/platform_dev')
  })

  it('takes the worker port from WORKER_PORT when it is set', () => {
    expect(devServiceEnv(DevService.WORKER, { ...BASE, WORKER_PORT: '9091' })['PORT']).toBe('9091')
  })

  it('refuses to start a worker it cannot give a database role', () => {
    expect(() =>
      devServiceEnv(DevService.WORKER, { ...BASE, DB_WORKER_PASSWORD: undefined })
    ).toThrow('DB_WORKER_PASSWORD')
    expect(() => devServiceEnv(DevService.WORKER, { ...BASE, DATABASE_URL: undefined })).toThrow(
      'DATABASE_URL'
    )
  })

  it('takes an empty WORKER_PORT for no WORKER_PORT', () => {
    expect(devServiceEnv(DevService.WORKER, { ...BASE, WORKER_PORT: '' })['PORT']).toBe('8081')
  })

  it('keeps the query of the pooler URL and encodes a password that has URL characters', () => {
    const env = devServiceEnv(DevService.WORKER, {
      ...BASE,
      DATABASE_URL: `${BASE.DATABASE_URL}?pgbouncer=true&connection_limit=5`,
      DB_WORKER_PASSWORD: 'p@ss/w#rd:1 x'
    })
    const url = new URL(env['DATABASE_URL'] ?? '')
    expect(url.searchParams.get('pgbouncer')).toBe('true')
    expect(url.searchParams.get('connection_limit')).toBe('5')
    expect(url.password).toBe(encodeURIComponent('p@ss/w#rd:1 x').replace(/%20/g, '%20'))
    expect(decodeURIComponent(url.password)).toBe('p@ss/w#rd:1 x')
    expect(url.hostname).toBe('localhost')
  })

  it('does not put a password in the message of an error', () => {
    const secret = 'SECRET-IN-THE-URL'
    let message = ''
    try {
      // Not a URL (the port is not a number), and it carries a password
      devServiceEnv(DevService.WORKER, {
        ...BASE,
        DATABASE_URL: `postgresql://platform_app:${secret}@localhost:notaport/platform_dev`
      })
    } catch (error) {
      message = String(error)
    }
    expect(message).toContain('DATABASE_URL')
    expect(message).not.toContain(secret)
    expect(message).not.toContain(BASE.DB_WORKER_PASSWORD)
  })
})
