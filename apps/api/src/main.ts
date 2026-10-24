import './instrument'

import { runHttpApp } from '@platform/core/http'

import { AppModule } from './app.module'

void runHttpApp(AppModule, { rawBody: true })
