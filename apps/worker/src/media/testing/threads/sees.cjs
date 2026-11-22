const { parentPort } = require('node:worker_threads')
const { Buffer } = require('node:buffer')
// What a hostile parser could read: the environment, the arguments and the options of node of the process that started it
const seen = JSON.stringify({
  env: Object.keys(process.env),
  argv: process.argv.slice(2),
  execArgv: process.execArgv
})
parentPort.postMessage({
  kind: 'sanitized',
  body: new Uint8Array(Buffer.from('%PDF-' + seen + '\n%%EOF'))
})
