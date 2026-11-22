// sharp (images) is a native binary: it is loaded from node_modules, see docker/node-service.Dockerfile.
// The thread that parses a document (Step 7.3) is a second entry: dist/apps/worker/document-thread.js, next to main.js
module.exports = require('../../tools/rspack/nest-bundle.cjs')('worker', ['sharp'], {
  'document-thread': 'apps/worker/src/media/document-thread.entry.ts'
})
