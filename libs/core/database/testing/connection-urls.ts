// The three connections the integration suites use, built from the variables the CI job and
// .env.example already define. Read only here: the suites themselves never touch process.env.
function required(name: string): string {
  const value = process.env[name]
  if (value === undefined || value === '') {
    throw new Error(`${name} is required for the integration tests (see .env.example)`)
  }
  return value
}

function asRole(url: string, role: string, password: string): string {
  const parsed = new URL(url)
  parsed.username = role
  parsed.password = password
  return parsed.toString()
}

export function connectionUrls(): { owner: string; app: string; worker: string } {
  const owner = required('DIRECT_DATABASE_URL')
  return {
    owner,
    app: asRole(owner, 'platform_app', required('DB_APP_PASSWORD')),
    worker: asRole(owner, 'platform_worker', required('DB_WORKER_PASSWORD'))
  }
}
