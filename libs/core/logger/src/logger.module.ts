import { type DynamicModule, Module } from '@nestjs/common'
import { LoggerModule as PinoLoggerModule } from 'nestjs-pino'
import pinoPretty from 'pino-pretty'

import { buildPinoHttpOptions, type LoggerOptions } from './logger-options'

@Module({})
export class LoggerModule {
  // The options come from the validated env of the app that imports this module
  static forRoot(options: LoggerOptions): DynamicModule {
    return {
      module: LoggerModule,
      imports: [
        // pino-pretty is a stream of this process and not a pino transport: a transport starts a
        // worker thread that loads the module by path, which a bundle cannot offer
        PinoLoggerModule.forRoot({
          pinoHttp: options.pretty
            ? [buildPinoHttpOptions(options), pinoPretty({ colorize: true, singleLine: true })]
            : buildPinoHttpOptions(options)
        })
      ],
      exports: [PinoLoggerModule]
    }
  }
}
