import type { Locale } from '@platform/core/i18n'

import type messages from './messages/en.json'

declare module 'next-intl' {
  interface AppConfig {
    Locale: Locale
    Messages: typeof messages
  }
}
