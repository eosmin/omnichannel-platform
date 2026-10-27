import { Global, Module } from '@nestjs/common'

import { env } from '@platform/core/config/env'

// How many proxies are in front of the service (TRUST_PROXY_HOPS), for what reads the address of a
// client outside of Express
export const TRUST_PROXY_HOPS = Symbol('TRUST_PROXY_HOPS')

@Global()
@Module({
  providers: [{ provide: TRUST_PROXY_HOPS, useValue: env.TRUST_PROXY_HOPS }],
  exports: [TRUST_PROXY_HOPS]
})
export class TrustProxyModule {}
