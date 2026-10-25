const { builtinModules } = require('node:module')
const fs = require('node:fs')
const path = require('node:path')

const WORKSPACE_ROOT = path.resolve(__dirname, '..', '..')

// Optional packages that Nest loads lazily. The Nest CLI ignores them when they are not installed
// but only lists the names without ".js", and Nest 12 imports them with it.
const LAZY_NEST_PACKAGES = ['@nestjs/microservices', '@nestjs/websockets']

// Looks at the folder and not at require.resolve: a package whose exports do not list its
// package.json would be taken for a missing one, and ignored when it is in fact installed
function isInstalled(name) {
  return fs.existsSync(path.join(WORKSPACE_ROOT, 'node_modules', name, 'package.json'))
}

function withAutomaticJsxRuntime(loader) {
  if (loader.loader !== 'builtin:swc-loader') return loader
  const jsc = loader.options.jsc
  return {
    ...loader,
    options: {
      ...loader.options,
      jsc: { ...jsc, transform: { ...jsc.transform, react: { runtime: 'automatic' } } }
    }
  }
}

// The Nest CLI keeps node_modules out of the bundle by default. The image has no node_modules (it
// would drag in every dependency of the monorepo, Next.js and React included), so everything is
// bundled in. The output is ESM, and the bundled CommonJS packages expect require('events') to
// return the class itself, so Node's built-in modules are required (node-commonjs), not imported.
//
// Rspack configuration of an app built with `nest build`: pass the name of the app (dist/apps/<name>).
module.exports = appName => (defaults, rspack) => ({
  output: { ...defaults.output, path: path.join(WORKSPACE_ROOT, 'dist', 'apps', appName) },
  // The Nest CLI's SWC loader compiles JSX with the classic runtime (React.createElement) and ignores
  // "jsx": "react-jsx" of the tsconfig, so the email templates (.tsx) die with "React is not defined"
  // in the bundle while passing under ts-jest. Use the automatic runtime, as the tsconfig says.
  module: {
    ...defaults.module,
    rules: defaults.module.rules.map(rule => ({
      ...rule,
      use: rule.use.map(loader => withAutomaticJsxRuntime(loader))
    }))
  },
  externals: [
    ({ request }, callback) => {
      if (request === undefined) return callback()
      // Some built-ins exist only with the prefix (node:sqlite, node:test): the prefix is enough
      const builtin = request.startsWith('node:') || builtinModules.includes(request)
      return builtin ? callback(null, `node-commonjs ${request}`) : callback()
    }
  ],
  plugins: [
    ...defaults.plugins,
    ...LAZY_NEST_PACKAGES.filter(name => !isInstalled(name)).map(
      name => new rspack.IgnorePlugin({ resourceRegExp: new RegExp(`^${name}/.+\\.js$`) })
    ),
    // pg loads its optional native driver lazily and never needs it here
    new rspack.IgnorePlugin({ resourceRegExp: /^pg-native$/ })
  ]
})
