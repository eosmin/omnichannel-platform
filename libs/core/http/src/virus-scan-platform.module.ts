import { Module } from '@nestjs/common'

import { env } from '@platform/core/config/env'

export const CLAMAV_ADDRESS = Symbol('CLAMAV_ADDRESS')
export interface ClamavAddress {
  host: string
  port: number
}

// Where the ClamAV daemon is, from the validated env (CLAMAV_HOST, CLAMAV_PORT). Only the worker
// scans, so only the worker imports it.
@Module({
  providers: [
    {
      provide: CLAMAV_ADDRESS,
      useValue: { host: env.CLAMAV_HOST, port: env.CLAMAV_PORT } satisfies ClamavAddress
    }
  ],
  exports: [CLAMAV_ADDRESS]
})
export class VirusScanPlatformModule {}
