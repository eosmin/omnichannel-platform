import { createHmac } from 'node:crypto'

import { Module } from '@nestjs/common'

import { env } from '@platform/core/config/env'
import { SEARCH_HASH_KEY } from '@platform/core/domain'

// Keys the hash of a search text with the secret of the validated env
@Module({
  providers: [
    {
      provide: SEARCH_HASH_KEY, // Derived, with its own label: the signing secret itself is never the key of anything else
      useFactory: (): string =>
        createHmac('sha256', env.JWT_SECRET).update('search-query-hash-key:v1').digest('hex')
    }
  ],
  exports: [SEARCH_HASH_KEY]
})
export class SearchPlatformModule {}
