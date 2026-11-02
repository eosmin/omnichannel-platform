import { createSerwistRoute } from '@serwist/turbopack'

// Builds `sw.ts` into /serwist/sw.js, with the header that lets it control the whole origin. The
// worker is registered by the push prompt (lib/push), not on every page. The proxy leaves this
// path out of its matcher: a worker is fetched with no page around it, and the update check of the
// browser must not be sent to the login.
export const { dynamic, dynamicParams, revalidate, generateStaticParams, GET } = createSerwistRoute(
  {
    swSrc: 'sw.ts',
    // A classic script: every browser that does push runs it, module workers are not everywhere
    esbuildOptions: { format: 'iife' },
    useNativeEsbuild: true
  }
)
