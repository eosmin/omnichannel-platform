import { readdirSync, readFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { type E2ePerson, E2ePersonRoles } from '@platform/core/database-testing'

// Who a spec file signs in as. The magic link allows a few a minute per address (MagicLinkThrottle), so a
// spec file never shares an address with another one: it asks `personOf(role, import.meta.url)` and gets an
// address that is its own, whichever slice of the suite it runs in. The global setup finds those calls in the
// specs and makes the people (`loadE2ePeople`), so a new spec needs no list to join, and a spec that signs in
// as a person nobody made is refused by `link-budget.ts` with its name, instead of waiting on a shared one.
const ROLES: readonly string[] = Object.values(E2ePersonRoles)
const SPEC_SUFFIX = '.spec.ts'
const CALL = /personOf\(\s*'([a-z]+)'\s*,\s*import\.meta\.url\s*(?:,\s*(\d+)\s*)?\)/g
export const PEOPLE_DOMAIN = 'test.com'

export function specSlug(specFile: string): string {
  return basename(specFile.startsWith('file:') ? fileURLToPath(specFile) : specFile).replace(
    SPEC_SUFFIX,
    ''
  )
}

// A short stable tag of a spec file name, for the display name: a name made of the file name would put words
// like "team" on the page of the specs that read it
function tagOf(text: string): string {
  let hash = 5381
  for (const char of text) hash = (hash * 33 + char.charCodeAt(0)) % 0xffffff
  return hash.toString(16).padStart(6, '0')
}

function personFor(role: string, slug: string, slot: number): E2ePerson {
  if (!ROLES.includes(role))
    throw new Error(`personOf: "${role}" is not one of ${ROLES.join(', ')}`)
  const tag = slot === 0 ? role : `${role}${slot + 1}`
  return {
    email: `${tag}.${slug}@${PEOPLE_DOMAIN}`,
    name: `Tester ${tagOf(`${tag}.${slug}`)}`,
    role: role as E2ePerson['role']
  }
}

// The address of a person of the spec file that asks (pass `import.meta.url`). A second person of the same
// role in one file takes the next slot: `personOf('admin', import.meta.url, 1)`.
export function personOf(role: string, specFile: string, slot = 0): string {
  return personFor(role, specSlug(specFile), slot).email
}

// The people the specs of a folder ask for, by reading their source: what the global setup makes
export function peopleAskedIn(specsDir: string): E2ePerson[] {
  const found = new Map<string, E2ePerson>()
  for (const file of readdirSync(specsDir).filter(name => name.endsWith(SPEC_SUFFIX))) {
    const slug = specSlug(file)
    for (const call of readFileSync(join(specsDir, file), 'utf8').matchAll(CALL)) {
      const person = personFor(call[1] ?? '', slug, Number(call[2] ?? 0))
      found.set(person.email, person)
    }
  }
  return [...found.values()]
}
