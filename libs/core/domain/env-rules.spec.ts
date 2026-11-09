import { isDeployedEnvironment, pickEnv } from './env-rules'

describe('pickEnv', () => {
  const source = { META_APP_SECRET: 's', JWT_SECRET: 'j', NODE_ENV: 'production' }

  it('hands over only the keys asked for, and none of the core secrets', () => {
    const picked = pickEnv(source, ['NODE_ENV', 'META_APP_SECRET'])
    expect(picked).toEqual({ NODE_ENV: 'production', META_APP_SECRET: 's' })
    expect('JWT_SECRET' in picked).toBe(false)
  })

  it('says a key that is not set as undefined, and freezes the copy', () => {
    const picked = pickEnv(source, ['META_APP_ID'])
    expect(picked).toEqual({ META_APP_ID: undefined })
    expect(Object.isFrozen(picked)).toBe(true)
  })
})

describe('isDeployedEnvironment', () => {
  it('is staging and production only', () => {
    expect(['development', 'test'].some(isDeployedEnvironment)).toBe(false)
    expect(['staging', 'production'].every(isDeployedEnvironment)).toBe(true)
  })
})
