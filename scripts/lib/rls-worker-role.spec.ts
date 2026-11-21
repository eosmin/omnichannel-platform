import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  alreadyAsRequested,
  confirmationOf,
  confirmProblem,
  connectionsProblem,
  connectionsSummary,
  allowedHostOf,
  flagProblem,
  forceConnectedOf,
  hostProblem,
  readWorkerConnections,
  reachedDatabasesWarning,
  WORKER_ROLE,
  WORKER_ROLE_MODES,
  workerRoleProblem,
  workerRoleStatement
} from './rls-worker-role'

describe('workerRoleStatement', () => {
  it('turns the bypass off for nobypass and back on for bypass, and changes nothing for status', () => {
    expect(workerRoleStatement('nobypass')).toBe('ALTER ROLE platform_worker NOBYPASSRLS')
    expect(workerRoleStatement('bypass')).toBe('ALTER ROLE platform_worker BYPASSRLS')
    expect(workerRoleStatement('status')).toBeNull()
  })

  it('names the role the worker connects as, and only that one', () => {
    expect(WORKER_ROLE).toBe('platform_worker')
    for (const mode of WORKER_ROLE_MODES) {
      const statement = workerRoleStatement(mode)
      if (statement !== null) expect(statement).toContain(` ${WORKER_ROLE} `)
    }
  })
})

describe('workerRoleProblem', () => {
  it('has no problem for a role that cannot skip row security', () => {
    expect(workerRoleProblem({ rolsuper: false, rolbypassrls: false })).toBeUndefined()
  })

  it('names the bypass, the superuser and the missing role', () => {
    expect(workerRoleProblem({ rolsuper: false, rolbypassrls: true })).toContain('BYPASSRLS')
    expect(workerRoleProblem({ rolsuper: true, rolbypassrls: false })).toContain('superuser')
    expect(workerRoleProblem(undefined)).toContain('missing')
  })

  it('reports both when the role is a superuser with BYPASSRLS', () => {
    const problem = workerRoleProblem({ rolsuper: true, rolbypassrls: true })
    expect(problem).toContain('BYPASSRLS')
    expect(problem).toContain('superuser')
  })
})

describe('confirmationOf', () => {
  it('reads the name of the database from the flag, wherever it is', () => {
    expect(confirmationOf(['nobypass', '--confirm=platform_ci'])).toBe('platform_ci')
    expect(confirmationOf(['--confirm=x', 'bypass'])).toBe('x')
    expect(confirmationOf(['nobypass'])).toBeUndefined()
    expect(confirmationOf(['nobypass', '--confirm='])).toBeUndefined()
  })
})

describe('confirmProblem', () => {
  it('never asks for confirmation to read', () => {
    expect(confirmProblem('status', undefined, 'platform')).toBeUndefined()
  })

  it('refuses to change the role with no confirmation, and says what to type', () => {
    for (const mode of ['nobypass', 'bypass'] as const) {
      const problem = confirmProblem(mode, undefined, 'platform_prod')
      expect(problem).toContain('--confirm=')
      // Not ready to paste: the name of the database is not in the message
      expect(problem).not.toContain('platform_prod')
    }
  })

  it('refuses the way back while the environment still has the flag of the worker ON', () => {
    expect(flagProblem('bypass', { WORKER_RLS_CONTEXT: 'true' })).toContain('would not start')
    expect(flagProblem('bypass', { WORKER_RLS_CONTEXT: 'false' })).toBeUndefined()
    expect(flagProblem('bypass', {})).toBeUndefined()
    expect(flagProblem('nobypass', { WORKER_RLS_CONTEXT: 'true' })).toBeUndefined()
  })

  it('refuses a confirmation that names another database, and accepts the right one', () => {
    expect(confirmProblem('nobypass', 'platform_ci', 'platform_prod')).toContain('not the database')
    expect(confirmProblem('nobypass', 'platform_ci', 'platform_ci')).toBeUndefined()
    expect(confirmProblem('bypass', 'platform_ci', 'platform_ci')).toBeUndefined()
  })
})

describe('alreadyAsRequested', () => {
  it('is true only when the role is already as the mode asks', () => {
    const bound = { rolsuper: false, rolbypassrls: false }
    const bypassing = { rolsuper: false, rolbypassrls: true }
    expect(alreadyAsRequested('nobypass', bound)).toBe(true)
    expect(alreadyAsRequested('nobypass', bypassing)).toBe(false)
    expect(alreadyAsRequested('bypass', bypassing)).toBe(true)
    expect(alreadyAsRequested('bypass', bound)).toBe(false)
    expect(alreadyAsRequested('status', bound)).toBe(false)
  })
})

// The owner changes the bypass of the worker by hand, in the order of the runbook. Whatever a deploy runs by itself (the migrations, the
// scripts of package.json that migrate, build or start, the images, the compose file, the bootstrap script, the composite actions)
// must never call the script, or a deploy would change what the worker sees in production without the owner. The CI workflow is the one
// place that names it, for the database of its own jobs; the migrations are checked by `roleViolations` (scripts/lib/rls.ts)
describe('the deploy paths and the script that changes the bypass of the worker', () => {
  const root = join(__dirname, '..', '..')
  const NAMES = /worker-role|NOBYPASSRLS/i

  it('has no script of package.json that migrates, builds, starts or deploys call it', () => {
    const scripts = (
      JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
        scripts: Record<string, string>
      }
    ).scripts
    const automatic = Object.entries(scripts).filter(([name]) =>
      /migrate|deploy|build|start|prepare|postinstall|bootstrap/.test(name)
    )
    expect(automatic.length).toBeGreaterThan(0)
    for (const [name, command] of automatic) {
      expect([name, NAMES.test(command)]).toEqual([name, false])
    }
  })

  it('is not named by the images, the compose file, the bootstrap script or the composite actions', () => {
    const files = execFileSync('git', ['ls-files'], { cwd: root, encoding: 'utf8' })
      .split('\n')
      .filter(file =>
        /(^|\/)(Dockerfile|docker-compose|[^/]*\.Dockerfile)|entrypoint|\.sh$|^\.github\/actions\//i.test(
          file
        )
      )
    expect(files.length).toBeGreaterThan(3)
    for (const file of files) {
      expect([file, NAMES.test(readFileSync(join(root, file), 'utf8'))]).toEqual([file, false])
    }
  })
})

describe('reachedDatabasesWarning', () => {
  it('says that the change reaches every database where the role connects, and names the others', () => {
    const text = reachedDatabasesWarning(['platform', 'platform_dev', 'platform_ci'], 'platform')
    expect(text).toContain('ALL the databases')
    expect(text).toContain('platform, platform_dev, platform_ci')
    expect(text).toContain('2 other databases: platform_dev, platform_ci')
  })

  it('says so when the database is the only one, and handles the singular', () => {
    expect(reachedDatabasesWarning(['platform'], 'platform')).toContain('no other database')
    expect(reachedDatabasesWarning(['platform', 'b'], 'platform')).toContain('1 other database: b')
  })
})

describe('connectionsProblem', () => {
  const idle = { visible: true, connections: [] }
  const busy = {
    visible: true,
    connections: [
      { datname: 'platform', count: 3 },
      { datname: 'platform_dev', count: 1 }
    ]
  }

  it('lets nobypass go on when no session of the role is connected', () => {
    expect(connectionsProblem('nobypass', idle, false)).toBeUndefined()
  })

  it('refuses nobypass while workers are connected, names where, and says to stop the workers', () => {
    const problem = connectionsProblem('nobypass', busy, false)
    expect(problem).toContain('4 connections')
    expect(problem).toContain('platform (3)')
    expect(problem).toContain('platform_dev (1)')
    expect(problem).toContain('stop the workers')
  })

  it('refuses nobypass when the sessions of the role cannot be seen, because zero would be a guess', () => {
    const problem = connectionsProblem('nobypass', { visible: false, connections: [] }, false)
    expect(problem).toContain('pg_read_all_stats')
  })

  it('lets --force-connected go on in both cases (the rehearsal)', () => {
    expect(connectionsProblem('nobypass', busy, true)).toBeUndefined()
    expect(
      connectionsProblem('nobypass', { visible: false, connections: [] }, true)
    ).toBeUndefined()
  })

  it('does not ask the other modes to stop the workers', () => {
    expect(connectionsProblem('status', busy, false)).toBeUndefined()
    expect(connectionsProblem('bypass', busy, false)).toBeUndefined()
  })
})

describe('connectionsSummary', () => {
  it('counts the sessions per database, and says when it cannot see them', () => {
    expect(connectionsSummary({ visible: true, connections: [] })).toContain('0 connections')
    expect(
      connectionsSummary({ visible: true, connections: [{ datname: 'platform', count: 2 }] })
    ).toContain('2 connections: platform (2)')
    expect(connectionsSummary({ visible: false, connections: [] })).toContain('cannot be seen')
  })
})

describe('forceConnectedOf', () => {
  it('is true only with the flag typed out', () => {
    expect(forceConnectedOf(['nobypass', '--force-connected'])).toBe(true)
    expect(forceConnectedOf(['nobypass', '--confirm=x'])).toBe(false)
  })
})

describe('hostProblem', () => {
  it('lets a local host go and refuses another one unless it is allowed by name', () => {
    for (const host of ['localhost', '127.0.0.1', '::1', '[::1]']) {
      expect(hostProblem('nobypass', host, undefined)).toBeUndefined()
    }
    expect(hostProblem('nobypass', 'db.example.com', undefined)).toContain('--allow-host=')
    expect(hostProblem('nobypass', 'db.example.com', 'db.example.com')).toBeUndefined()
    expect(hostProblem('nobypass', 'db.example.com', 'other.example.com')).toContain('not the host')
  })

  it('treats the socket, loopback ranges, case and a final dot as this machine', () => {
    for (const host of ['', '/var/run/postgresql', '127.0.0.2', 'LOCALHOST', 'localhost.']) {
      expect(hostProblem('nobypass', host, undefined)).toBeUndefined()
    }
    expect(hostProblem('nobypass', '0.0.0.0', undefined)).toContain('--allow-host=')
  })

  it('reads --allow-host and ignores an empty value', () => {
    expect(allowedHostOf(['nobypass', '--allow-host=db.example.com'])).toBe('db.example.com')
    expect(allowedHostOf(['nobypass', '--allow-host='])).toBeUndefined()
    expect(allowedHostOf(['nobypass'])).toBeUndefined()
  })

  it('never asks it to read', () => {
    expect(hostProblem('status', 'db.example.com', undefined)).toBeUndefined()
  })
})

describe('readWorkerConnections', () => {
  it('reads the visibility of the sessions and the count of the role per database, without its own session', async () => {
    const calls: { text: string; values: unknown[] | undefined }[] = []
    const answers: { rows: Record<string, unknown>[] }[] = [
      { rows: [{ visible: true }] },
      {
        rows: [
          { datname: 'platform', total: '2' },
          { datname: null, total: '1' }
        ]
      }
    ]
    const facts = await readWorkerConnections({
      query: (text: string, values?: unknown[]) => {
        calls.push({ text, values })
        return Promise.resolve(answers[calls.length - 1] ?? { rows: [] })
      }
    })
    expect(facts).toEqual({
      visible: true,
      connections: [
        { datname: 'platform', count: 2 },
        { datname: '?', count: 1 }
      ]
    })
    expect(calls[1]?.text).toContain('pg_backend_pid()')
    expect(calls[1]?.values).toEqual(['platform_worker'])
  })
})
