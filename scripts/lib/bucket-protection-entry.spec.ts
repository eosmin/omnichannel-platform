import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { env as shellEnv } from 'node:process'

// The entry point itself (scripts/bucket-protection.ts), run as the operator runs it, in a shell that has only what each case gives it.
// Every case ends before the first request, so no network and no bucket are needed.
const ROOT = join(__dirname, '../..')
const TSX = join(ROOT, 'node_modules/.bin/tsx')
const SECRET = 'wJalrXUtnFEMI-entry-spec-secret'

function runEntry(
  args: string[],
  env: Record<string, string>
): { status: number | null; output: string } {
  const result = spawnSync(TSX, [join(ROOT, 'scripts/bucket-protection.ts'), ...args], {
    cwd: ROOT,
    env: { PATH: shellEnv.PATH ?? '', HOME: shellEnv.HOME ?? '', ...env },
    encoding: 'utf8',
    timeout: 60_000
  })
  return { status: result.status, output: `${result.stdout}${result.stderr}` }
}

describe('scripts/bucket-protection.ts', () => {
  it('exits 2 and asks for the environment when the shell has no credentials, even though .env.example sits in the repository', () => {
    const { status, output } = runEntry(['status'], {})
    expect(status).toBe(2)
    expect(output).toContain('AWS_ACCESS_KEY_ID')
  })

  it('exits 2 on an unknown mode before reading the environment', () => {
    const { status, output } = runEntry(['delete'], {})
    expect(status).toBe(2)
    expect(output).toContain('unknown mode')
  })

  it('refuses the bucket of local development and never prints the credentials it was given', () => {
    const { status, output } = runEntry(['apply', '--confirm=platform-dev'], {
      AWS_ACCESS_KEY_ID: 'AKIAENTRYSPECKEY',
      AWS_SECRET_ACCESS_KEY: SECRET,
      AWS_SESSION_TOKEN: `${SECRET}-token`,
      S3_BUCKET: 'platform-dev'
    })
    expect(status).toBe(2)
    expect(output).toContain('local development')
    expect(output).not.toContain(SECRET)
    expect(output).not.toContain('AKIAENTRYSPECKEY')
  })

  it('refuses a local endpoint, shows its host only and prints no credential', () => {
    const { status, output } = runEntry(['status'], {
      AWS_ACCESS_KEY_ID: 'AKIAENTRYSPECKEY',
      AWS_SECRET_ACCESS_KEY: SECRET,
      S3_BUCKET: 'acme-production',
      S3_ENDPOINT: `http://operator:${SECRET}@localhost:9000/path`
    })
    expect(status).toBe(2)
    expect(output).toContain('localhost')
    expect(output).not.toContain(SECRET)
  })

  it('refuses to change a bucket without --confirm', () => {
    const { status, output } = runEntry(['apply'], {
      AWS_ACCESS_KEY_ID: 'AKIAENTRYSPECKEY',
      AWS_SECRET_ACCESS_KEY: SECRET,
      S3_BUCKET: 'acme-production',
      S3_ENDPOINT: 'https://s3.example.com'
    })
    expect(status).toBe(2)
    expect(output).toContain('--confirm=acme-production')
  })
})
