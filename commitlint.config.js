// Conventional Commits (TDD_14 §7). The scopes are advice (a warning), the types and the length of
// the subject are enforced.
export default {
  extends: ['@commitlint/config-conventional'],
  // Dependabot writes its own titles and body lines, which can exceed the length rules
  ignores: [message => message.includes('Signed-off-by: dependabot[bot]')],
  rules: {
    'type-enum': [
      2,
      'always',
      ['feat', 'fix', 'docs', 'style', 'refactor', 'test', 'chore', 'perf', 'ci', 'revert', 'build']
    ],
    'scope-enum': [
      1,
      'always',
      [
        'api',
        'web',
        'widget',
        'worker',
        'db',
        'database',
        'infra',
        'ci',
        'config',
        'core',
        'crypto',
        'docker',
        'http',
        'logger',
        'metrics',
        'observability',
        'plan',
        'tooling',
        'auth',
        'tenancy',
        'conversations',
        'messages',
        'customers',
        'orders',
        'products',
        'inventory',
        'shipping',
        'media',
        'search',
        'notifications',
        'realtime',
        'analytics',
        'plugins',
        'channels',
        'whatsapp',
        'instagram',
        'messenger',
        'web-widget',
        'email',
        'i18n',
        'compliance',
        'settings',
        'webhooks',
        'queues',
        'storage',
        'deps',
        'docs'
      ]
    ],
    'subject-max-length': [2, 'always', 72],
    'body-max-line-length': [1, 'always', 100]
  }
}
