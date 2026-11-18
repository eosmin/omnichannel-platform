import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'

// The root of the repository, where prisma.config.ts is: the suites run from tests/ and the scripts from the root, and this
// file is loaded both as CommonJS (jest) and as a module (tsx), so it cannot ask where it sits
export function repositoryRoot(): string {
  for (let dir = process.cwd(); ; dir = dirname(dir)) {
    if (existsSync(join(dir, 'prisma.config.ts'))) return dir
    if (dirname(dir) === dir)
      throw new Error('prisma.config.ts not found above the working directory')
  }
}
