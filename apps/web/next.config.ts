import path from 'node:path'

import type { NextConfig } from 'next'
import createNextIntlPlugin from 'next-intl/plugin'

import { STATIC_SECURITY_HEADERS } from './lib/security-headers'

// The build of the e2e-tests job also compiles the `*.e2e.tsx` pages (the harness of the realtime
// cases); the build of the image does not, so those routes do not exist where the app is deployed
const E2E_PAGE_EXTENSIONS = process.env['E2E_HARNESS'] === '1' ? ['e2e.tsx'] : []

const nextConfig: NextConfig = {
  pageExtensions: ['tsx', 'ts', 'jsx', 'js', ...E2E_PAGE_EXTENSIONS],
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
