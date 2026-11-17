import { Module } from '@nestjs/common'
import { APP_FILTER, APP_PIPE } from '@nestjs/core'

import { GlobalExceptionFilter } from './global-exception.filter'
import { RejectNulPipe } from './reject-nul.pipe'

// Every error the app raises leaves through the error contract of TDD_02 §6. A NUL in what a request
// carries is the caller's error on every route, so it is refused here once (400) and not left to the
// database (500).
@Module({
  providers: [
    { provide: APP_FILTER, useClass: GlobalExceptionFilter },
    { provide: APP_PIPE, useClass: RejectNulPipe }
  ]
})
export class HttpErrorsModule {}
