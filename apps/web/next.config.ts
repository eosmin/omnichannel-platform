import path from 'node:path'

import type { NextConfig } from 'next'
import createNextIntlPlugin from 'next-intl/plugin'

import { STATIC_SECURITY_HEADERS } from './lib/security-headers'

const nextConfig: NextConfig = {
  // `next dev` would write an AGENTS.md here; the agent instructions of this repo live in CLAUDE.md
  agentRules: false,
  // The image runs the server that `next build` traces, with only the files it needs. The libs the
  // app imports sit outside apps/web, so the trace starts at the repository root
  output: 'standalone',
  outputFileTracingRoot: path.join(__dirname, '../..'),
  // The Content-Security-Policy is set per request in proxy.ts, because it carries a nonce
  headers: () => Promise.resolve([{ source: '/(.*)', headers: [...STATIC_SECURITY_HEADERS] }])
}

const withNextIntl = createNextIntlPlugin()

export default withNextIntl(nextConfig)
