import './instrument'

import { runHttpApp } from '@platform/core/http'

import { AppModule } from './app.module'
import { useRealtime } from './modules/realtime'

void runHttpApp(AppModule, { rawBody: true, beforeInit: useRealtime })
