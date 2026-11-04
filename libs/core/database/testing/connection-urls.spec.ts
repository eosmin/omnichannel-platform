import { connectionUrls, TEST_DATABASE_NAME } from './connection-urls'

const DEV_URL = 'postgresql://platform:dev_password@localhost:5432/platform_dev'
const NAMES = [
  'CI',
  'TEST_DATABASE_URL',
  'DIRECT_DATABASE_URL',
  'DB_APP_PASSWORD',
  'DB_WORKER_PASSWORD'
] as const

describe('connectionUrls', () => {
  // The whole env, so that a variable the function starts to read later cannot leak between cases
  const original = { ...process.env }

  beforeEach(() => {
    for (const name of NAMES) delete process.env[name]
    process.env['DIRECT_DATABASE_URL'] = DEV_URL
    process.env['DB_APP_PASSWORD'] = 'app_password_1'
    process.env['DB_WORKER_PASSWORD'] = 'worker_password_1'
  })

  afterEach(() => {
    for (const name of Object.keys(process.env)) {
      if (!(name in original)) delete process.env[name]
    }
    Object.assign(process.env, original)
  })

  it('points a laptop at the test database, never at the one development uses', () => {
    const urls = connectionUrls()
    expect(new URL(urls.owner).pathname).toBe(`/${TEST_DATABASE_NAME}`)
    expect(new URL(urls.app).pathname).toBe(`/${TEST_DATABASE_NAME}`)
    expect(new URL(urls.worker).pathname).toBe(`/${TEST_DATABASE_NAME}`)
    expect(urls.owner).not.toContain('platform_dev')
  })

  it('keeps the host, the port and the owner credentials of DIRECT_DATABASE_URL', () => {
    const owner = new URL(connectionUrls().owner)
    expect(owner.hostname).toBe('localhost')
    expect(owner.port).toBe('5432')
    expect(owner.username).toBe('platform')
    expect(owner.password).toBe('dev_password')
  })

  it('connects each service with its own role', () => {
    const urls = connectionUrls()
    expect(new URL(urls.app).username).toBe('platform_app')
    expect(new URL(urls.app).password).toBe('app_password_1')
    expect(new URL(urls.worker).username).toBe('platform_worker')
    expect(new URL(urls.worker).password).toBe('worker_password_1')
  })

  it('uses DIRECT_DATABASE_URL as it is in CI, which has a database of its own', () => {
    process.env['CI'] = 'true'
    process.env['DIRECT_DATABASE_URL'] =
      'postgresql://platform:ci_password@localhost:5432/platform_ci'
    expect(new URL(connectionUrls().owner).pathname).toBe('/platform_ci')
  })

  it.each(['', 'false', 'False', 'FALSE', '0'])('does not take CI=%j for a CI run', value => {
    process.env['CI'] = value
    expect(new URL(connectionUrls().owner).pathname).toBe(`/${TEST_DATABASE_NAME}`)
  })

  it('refuses the development database even when CI=true is exported on a laptop', () => {
    process.env['CI'] = 'true'
    expect(() => connectionUrls()).toThrow('development database')
  })

  it('refuses TEST_DATABASE_URL when it names the development database', () => {
    process.env['TEST_DATABASE_URL'] = DEV_URL
    expect(() => connectionUrls()).toThrow('development database')
  })

  it('takes an empty TEST_DATABASE_URL for none', () => {
    process.env['TEST_DATABASE_URL'] = ''
    expect(new URL(connectionUrls().owner).pathname).toBe(`/${TEST_DATABASE_NAME}`)
  })

  it('catches the development database however its name is written', () => {
    process.env['TEST_DATABASE_URL'] =
      'postgresql://platform:x_password@localhost:5432/platform%5Fdev?a=1'
    expect(() => connectionUrls()).toThrow('development database')
  })

  it('lets TEST_DATABASE_URL win over both', () => {
    process.env['TEST_DATABASE_URL'] = 'postgresql://platform:x_password@127.0.0.1:5433/mine'
    const urls = connectionUrls()
    for (const url of [urls.owner, urls.app, urls.worker]) {
      expect(new URL(url).pathname).toBe('/mine')
      expect(new URL(url).host).toBe('127.0.0.1:5433')
    }
    process.env['CI'] = 'true'
    expect(new URL(connectionUrls().owner).pathname).toBe('/mine')
  })

  it('still requires DIRECT_DATABASE_URL when nothing else names a database', () => {
    delete process.env['DIRECT_DATABASE_URL']
    expect(() => connectionUrls()).toThrow('DIRECT_DATABASE_URL is required')
  })
})
