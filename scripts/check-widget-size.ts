import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { gzipSync } from 'node:zlib'

import { WidgetLimits } from '@platform/core/domain'

// Run by the build of the widget: the script loads on the sites of the stores, so its weight is a
// requirement and not a hope
const BUNDLE = resolve(import.meta.dirname, '../dist/apps/widget/widget.js')

const size = gzipSync(readFileSync(BUNDLE)).length
const limit = WidgetLimits.BUNDLE_MAX_GZIP_BYTES
process.stdout.write(`widget.js: ${size} bytes gzipped (limit ${limit})\n`)
if (size > limit) {
  process.stderr.write('the widget is over its size limit\n')
  process.exit(1)
}
