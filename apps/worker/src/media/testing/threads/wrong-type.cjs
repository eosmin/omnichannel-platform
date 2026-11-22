const { parentPort } = require('node:worker_threads')
// Small, plain bytes, but not a PDF
parentPort.postMessage({
  kind: 'sanitized',
  body: new Uint8Array(Buffer.from('MZ this is not a document'))
})
