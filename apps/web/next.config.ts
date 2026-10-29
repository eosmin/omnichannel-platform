import type { NextConfig } from 'next'
import createNextIntlPlugin from 'next-intl/plugin'

import { STATIC_SECURITY_HEADERS } from './lib/security-headers'

const nextConfig: NextConfig = {
  // The Content-Security-Policy is set per request in proxy.ts, because it carries a nonce
  headers: () => Promise.resolve([{ source: '/(.*)', headers: [...STATIC_SECURITY_HEADERS] }])
}

const withNextIntl = createNextIntlPlugin()

export default withNextIntl(nextConfig)
