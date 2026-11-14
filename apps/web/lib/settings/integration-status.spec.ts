import { ApiKeyStatus, WebhookStatus } from '@platform/core/domain'

import {
  API_KEY_ACTIVE,
  knownApiKeyStatus,
  knownWebhookStatus,
  WEBHOOK_ACTIVE,
  WEBHOOK_DISABLED,
  WEBHOOK_PAUSED
} from './integration-status'

describe('integration statuses', () => {
  it('read the values of the enums, so a renamed value cannot drift from the screen', () => {
    expect(WEBHOOK_ACTIVE).toBe(WebhookStatus.ACTIVE)
    expect(WEBHOOK_PAUSED).toBe(WebhookStatus.PAUSED)
    expect(WEBHOOK_DISABLED).toBe(WebhookStatus.DISABLED)
    expect(API_KEY_ACTIVE).toBe(ApiKeyStatus.ACTIVE)
  })

  it('give a text to every status of the enums and to none that is unknown', () => {
    for (const status of Object.values(WebhookStatus)) {
      expect(knownWebhookStatus(status)).toBe(status)
    }
    for (const status of Object.values(ApiKeyStatus)) {
      expect(knownApiKeyStatus(status)).toBe(status)
    }
    expect(knownWebhookStatus('suspended')).toBeNull()
    expect(knownApiKeyStatus('suspended')).toBeNull()
  })
})
