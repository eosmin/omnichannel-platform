// sharp (images) is a native binary: it is loaded from node_modules, see docker/node-service.Dockerfile
module.exports = require('../../tools/rspack/nest-bundle.cjs')('worker', ['sharp'])
