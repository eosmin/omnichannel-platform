import { localCommandsUrlAllowed } from '@platform/core/url-safety'

import { applyLocalCommandsUrlPolicy } from './local-commands-url-policy'

describe('applyLocalCommandsUrlPolicy', () => {
  afterEach(() => {
    applyLocalCommandsUrlPolicy({ NODE_ENV: 'test', PLUGIN_ALLOW_LOCAL_COMMANDS_URL: false })
  })

  it('leaves a plugin on this machine refused when the switch is off', () => {
    applyLocalCommandsUrlPolicy({ NODE_ENV: 'test', PLUGIN_ALLOW_LOCAL_COMMANDS_URL: false })
    expect(localCommandsUrlAllowed()).toBe(false)
  })

  it('allows it only for NODE_ENV=test with the switch on', () => {
    applyLocalCommandsUrlPolicy({ NODE_ENV: 'test', PLUGIN_ALLOW_LOCAL_COMMANDS_URL: true })
    expect(localCommandsUrlAllowed()).toBe(true)
  })

  it.each(['production', 'staging', 'development'])(
    'turns it off, and keeps it off, in %s with the switch on',
    nodeEnv => {
      applyLocalCommandsUrlPolicy({ NODE_ENV: 'test', PLUGIN_ALLOW_LOCAL_COMMANDS_URL: true })
      applyLocalCommandsUrlPolicy({ NODE_ENV: nodeEnv, PLUGIN_ALLOW_LOCAL_COMMANDS_URL: true })
      expect(localCommandsUrlAllowed()).toBe(false)
    }
  )
})
