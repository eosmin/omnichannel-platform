const { parentPort } = require('node:worker_threads')
parentPort.postMessage({ kind: 'sanitized', body: 'not bytes' })
