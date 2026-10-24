import { Module } from '@nestjs/common'

import { HttpPlatformModule } from '@platform/core/http'

@Module({ imports: [HttpPlatformModule] })
export class WorkerModule {}
