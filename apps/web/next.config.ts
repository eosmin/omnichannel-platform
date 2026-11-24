import path from 'node:path'

import type { NextConfig } from 'next'
import createNextIntlPlugin from 'next-intl/plugin'

import {
  DSR_VERIFY_PAGE_SOURCE,
  STATIC_SECURITY_HEADERS,
  UNSUBSCRIBE_PAGE_HEADERS,
  UNSUBSCRIBE_PAGE_SOURCE
} from './lib/security-headers'

const nextConfig: NextConfig = {
  // `next dev` would write an AGENTS.md here; the agent instructions of this repo live in CLAUDE.md
  agentRules: false,
  // The image runs the server that `next build` traces, with only the files it needs. The libs the
  // app imports sit outside apps/web, so the trace starts at the repository root
  output: 'standalone',
  outputFileTracingRoot: path.join(__dirname, '../..'),
  // Next.js would answer every dynamic page with `X-Powered-By: Next.js`, naming the framework
  poweredByHeader: false,
  // The Content-Security-Policy is set per request in proxy.ts, because it carries a nonce
  // The second rule overrides the same keys of the first for the pages that carry a token in their fragment only (the one-click unsubscribe and the confirmation of a data request)
  headers: () =>
    Promise.resolve([
      { source: '/(.*)', headers: [...STATIC_SECURITY_HEADERS] },
      { source: UNSUBSCRIBE_PAGE_SOURCE, headers: [...UNSUBSCRIBE_PAGE_HEADERS] },
      { source: DSR_VERIFY_PAGE_SOURCE, headers: [...UNSUBSCRIBE_PAGE_HEADERS] }
    ])
}

const withNextIntl = createNextIntlPlugin()

export default withNextIntl(nextConfig)
