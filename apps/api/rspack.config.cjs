// sharp (the icon of a channel plugin) is a native binary: it is loaded from node_modules, see docker/node-service.Dockerfile
module.exports = require('../../tools/rspack/nest-bundle.cjs')('api', ['sharp'])
