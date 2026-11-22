const { parentPort } = require('node:worker_threads')
// A well-formed answer over memory the thread keeps: it could change the bytes after they were checked
const memory = new SharedArrayBuffer(64)
const body = new Uint8Array(memory)
body.set(Buffer.from('%PDF-1.4 shared'))
parentPort.postMessage({ kind: 'sanitized', body })
