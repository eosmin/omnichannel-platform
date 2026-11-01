import { Module } from '@nestjs/common'

import { QueuesPlatformModule } from '@platform/core/http'

import { ExportsProcessor } from '../processors/exports.processor'
import { ProcessorSupport } from '../processors/processor-support'

import { CsvExportWriter } from './csv-export-writer'
import { ExpiredExportsCleaner } from './expired-exports-cleaner.service'
import { ExportGenerator } from './export-generator.service'
import { ZipExportWriter } from './zip-export-writer'

// The storage, the database and the logger come from the platform module of the worker, the audit
// service from the AuditModule of the worker module. Exports the cleaner: the scheduler runs it.
@Module({
  imports: [QueuesPlatformModule],
  providers: [
    ProcessorSupport,
    CsvExportWriter,
    ZipExportWriter,
    ExportGenerator,
    ExpiredExportsCleaner,
    ExportsProcessor
  ],
  exports: [ExpiredExportsCleaner]
})
export class ExportsModule {}
