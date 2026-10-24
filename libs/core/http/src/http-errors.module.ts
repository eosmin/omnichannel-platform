import { Module } from '@nestjs/common'
import { APP_FILTER } from '@nestjs/core'

import { GlobalExceptionFilter } from './global-exception.filter'

// Every error the app raises leaves through the error contract of TDD_02 §6
@Module({ providers: [{ provide: APP_FILTER, useClass: GlobalExceptionFilter }] })
export class HttpErrorsModule {}
