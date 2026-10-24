import { NestFactory } from '@nestjs/core'

import { AppModule } from './app.module'

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, { rawBody: true })
  await app.listen(8080)
}

void bootstrap()
