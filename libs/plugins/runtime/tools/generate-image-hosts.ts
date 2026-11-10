import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { officialImageHosts, renderImageHostsFile } from '../src/image-hosts-file'
import { OFFICIAL_CHANNEL_PLUGINS } from '../src/official-plugins'

// The hosts the browser may load the pictures of the channels from (Content-Security-Policy `img-src`), written
// from what the plugins declare (`imageHosts`) into a file the web app imports (Step 7.9 B2). The file is
// committed, and `--check` (CI `lint-and-types`, `pnpm validate:all`, the pre-push hook) fails until it is
// regenerated with `pnpm gen:image-hosts`; the web build itself does not run this script. The file has no imports:
// `next.config.ts` loads it before the aliases exist. It lives with the runtime because it needs the official
// plugins, which a script of the tooling scope may not depend on.
// Usage (from the root of the repository): tsx libs/plugins/runtime/tools/generate-image-hosts.ts [--check]
const OUTPUT = resolve(process.cwd(), 'apps/web/lib/generated/plugin-image-hosts.ts')

const wanted = renderImageHostsFile(officialImageHosts(OFFICIAL_CHANNEL_PLUGINS))

if (process.argv.includes('--check')) {
  let current = ''
  try {
    current = readFileSync(OUTPUT, 'utf8')
  } catch {
    // a missing file counts as out of date
  }
  if (current !== wanted) {
    process.stderr.write(
      'apps/web/lib/generated/plugin-image-hosts.ts is out of date with the plugins: run `pnpm gen:image-hosts`\n'
    )
    process.exit(1)
  }
  process.stdout.write('plugin image hosts: up to date\n')
} else {
  writeFileSync(OUTPUT, wanted)
  process.stdout.write('plugin image hosts: written\n')
}
