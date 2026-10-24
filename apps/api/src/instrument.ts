import { initSentryFromEnv } from '@platform/core/sentry'

// Imported first by main.ts, before any module it should observe
initSentryFromEnv()
