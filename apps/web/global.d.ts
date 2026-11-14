import type { Locale } from '@platform/core/i18n'

import type messages from './messages/en.json'
import type analyticsMessages from './messages/routes/analytics.en.json'
import type orderDetailMessages from './messages/routes/order-detail.en.json'
import type returnsMessages from './messages/routes/returns.en.json'

declare module 'next-intl' {
  interface AppConfig {
    Locale: Locale
    // The messages of a route that only that route loads (`messages/routes`, see `RouteMessages`) are part of the type
    Messages: typeof messages &
      typeof orderDetailMessages &
      typeof returnsMessages &
      typeof analyticsMessages
  }
}
