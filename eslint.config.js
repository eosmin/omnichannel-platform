import path from 'node:path'

import { defineConfig } from 'eslint/config'
import js from '@eslint/js'
import tseslint from 'typescript-eslint'
import nx from '@nx/eslint-plugin'
import importX from 'eslint-plugin-import-x'
import nextPlugin from '@next/eslint-plugin-next'

const processEnvBan = {
  selector: "MemberExpression[object.name='process'][property.name='env']",
  message: 'Read configuration through the validated env object'
}

const conversationStatusBan = {
  selector:
    "CallExpression[callee.property.name='update'][callee.object.property.name='conversation'] > ObjectExpression > Property[key.name='data'] > ObjectExpression > Property[key.name='status']",
  message: 'Change conversation status through ConversationsService.updateStatus'
}

const prismaTransactionBan = {
  selector: "CallExpression[callee.property.name='$transaction']",
  message: 'Use PrismaService.transaction(fn) so the tenant context is set (TDD_01 §3.2)'
}

// The answers and statuses of the api are built by libs/core/domain/errors (HttpStatusCodes, and
// resourceNotFound, resourceConflict, unauthorized): the usual second ways of writing them are
// refused (a number in PlatformException, @HttpCode or res.status, a constant of your own, the three
// codes by hand). Other forms (sendStatus, writeHead, HttpException) are caught in review
const STATUS_NUMBER = '/^[1-5][0-9]{2}$/'
const httpStatusBans = [
  {
    selector: `NewExpression[callee.name='PlatformException'] > Literal[raw=${STATUS_NUMBER}]`,
    message: 'Name the status: HttpStatusCodes.NOT_FOUND, not 404'
  },
  {
    selector: `CallExpression[callee.name='HttpCode'] > Literal[raw=${STATUS_NUMBER}]`,
    message: 'Name the status: @HttpCode(HttpStatusCodes.CREATED), not 201'
  },
  {
    selector: `CallExpression[callee.property.name='status'] > Literal[raw=${STATUS_NUMBER}]`,
    message: 'Name the status: res.status(HttpStatusCodes.NOT_FOUND), not 404'
  },
  {
    selector: `VariableDeclarator[id.name=/^(HTTP_)?(OK|CREATED|ACCEPTED|NO_CONTENT|BAD_REQUEST|UNAUTHORIZED|FORBIDDEN|NOT_FOUND|CONFLICT|GONE|TOO_MANY_REQUESTS|INTERNAL|INTERNAL_SERVER_ERROR)$/] > Literal[raw=${STATUS_NUMBER}]`,
    message: 'Use HttpStatusCodes from @platform/core/errors instead of a constant of your own'
  },
  {
    selector:
      "NewExpression[callee.name='PlatformException'] > MemberExpression[object.name='ErrorCodes'][property.name=/^(RESOURCE_NOT_FOUND|RESOURCE_CONFLICT|AUTH_UNAUTHORIZED)$/]",
    message:
      'Use resourceNotFound(), resourceConflict() or unauthorized() from @platform/core/errors'
  }
]

export default defineConfig([
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  ...nx.configs['flat/base'],
  ...nx.configs['flat/typescript'],
  importX.flatConfigs.recommended,
  importX.flatConfigs.typescript,

  {
    files: ['**/*.ts', '**/*.tsx', '**/*.cts', '**/*.mts'],
    settings: {
      // The @platform/* aliases live in tsconfig.base.json. Without an explicit path the resolver
      // looks for a tsconfig.json from the directory ESLint runs in, so the result changed between
      // the IDE (root) and Nx (the project): aliases were unresolved from the root.
      'import-x/resolver': {
        typescript: { project: path.join(import.meta.dirname, 'tsconfig.base.json') }
      }
    },
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname
      }
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/consistent-type-imports': ['error', { fixStyle: 'inline-type-imports' }],
      '@typescript-eslint/require-await': 'error',
      '@typescript-eslint/explicit-module-boundary-types': 'error',
      '@typescript-eslint/no-non-null-assertion': 'error',
      '@typescript-eslint/ban-ts-comment': [
        'error',
        { 'ts-expect-error': 'allow-with-description', 'ts-ignore': true }
      ],

      'no-console': 'error',
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['../../../*'],
              message: 'Use a workspace alias instead of deep relative imports'
            },
            {
              group: ['@platform/core/config'],
              message: 'Only libs/core may read env; apps/web uses its own lib/env.ts'
            }
          ]
        }
      ],
      'no-restricted-syntax': [
        'error',
        processEnvBan,
        conversationStatusBan,
        prismaTransactionBan,
        ...httpStatusBans
      ],

      'import-x/order': [
        'error',
        {
          groups: ['builtin', 'external', 'internal', 'parent', 'sibling'],
          'newlines-between': 'always',
          alphabetize: { order: 'asc' }
        }
      ],

      '@nx/enforce-module-boundaries': [
        'error',
        {
          depConstraints: [
            {
              sourceTag: 'scope:api',
              onlyDependOnLibsWithTags: [
                'scope:core',
                'scope:core-domain',
                'scope:plugins',
                'scope:channels'
              ]
            },
            {
              sourceTag: 'scope:worker',
              onlyDependOnLibsWithTags: [
                'scope:core',
                'scope:core-domain',
                'scope:plugins',
                'scope:channels'
              ]
            },
            {
              sourceTag: 'scope:web',
              onlyDependOnLibsWithTags: ['scope:core-domain', 'scope:api-client']
            },
            {
              sourceTag: 'scope:widget',
              onlyDependOnLibsWithTags: ['scope:core-domain']
            },
            {
              sourceTag: 'scope:api-client',
              onlyDependOnLibsWithTags: ['scope:core-domain']
            },
            {
              sourceTag: 'scope:channels',
              onlyDependOnLibsWithTags: ['scope:plugins', 'scope:core', 'scope:core-domain']
            },
            {
              sourceTag: 'scope:plugins',
              onlyDependOnLibsWithTags: ['scope:core-domain']
            },
            {
              sourceTag: 'scope:core',
              onlyDependOnLibsWithTags: ['scope:core', 'scope:core-domain']
            },
            {
              sourceTag: 'scope:tooling',
              onlyDependOnLibsWithTags: ['scope:core', 'scope:core-domain']
            },
            {
              sourceTag: 'scope:core-domain',
              onlyDependOnLibsWithTags: ['scope:core-domain']
            }
          ]
        }
      ]
    }
  },

  // The Next.js app also lints its React and Next rules
  {
    files: ['apps/web/**/*.ts', 'apps/web/**/*.tsx'],
    plugins: { '@next/next': nextPlugin },
    settings: { next: { rootDir: 'apps/web' } },
    rules: { ...nextPlugin.configs.recommended.rules }
  },

  // The libraries that build the modules of the apps may import the validated env; everything else
  // gets it through them. A block replaces the whole rule, so the deep-relative-import pattern is
  // repeated.
  {
    files: ['libs/core/http/**/*.ts', 'libs/core/platform/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['../../../*'],
              message: 'Use a workspace alias instead of deep relative imports'
            }
          ]
        }
      ]
    }
  },

  // The suites of the whole system build the real app of the api and talk to it over HTTP, so they
  // reach into it by path. Nothing depends on them.
  {
    files: ['tests/**/*.ts'],
    rules: { '@nx/enforce-module-boundaries': 'off' }
  },

  // Two files reach other projects by path on purpose: the env validator cross-checks the schemas of
  // the api, the worker and an app against their .env.example files, and the root prisma.config.ts is
  // the re-export the Prisma CLI looks for, which loads it without the tsconfig aliases
  {
    files: ['scripts/validate-env-example.ts', 'prisma.config.ts'],
    rules: { '@nx/enforce-module-boundaries': 'off' }
  },

  // Plain JavaScript (the Rspack configs): no type information, and the CommonJS globals
  {
    files: ['**/*.cjs'],
    languageOptions: {
      ...tseslint.configs.disableTypeChecked.languageOptions,
      sourceType: 'commonjs',
      globals: {
        require: 'readonly',
        module: 'writable',
        process: 'readonly',
        __dirname: 'readonly'
      }
    },
    rules: {
      ...tseslint.configs.disableTypeChecked.rules,
      '@typescript-eslint/no-require-imports': 'off'
    }
  },

  // Scripts and the seed are allowed to print; everything else uses Pino
  {
    files: [
      'scripts/**/*.ts',
      'libs/core/database/prisma/seed.ts',
      'libs/core/database/prisma/dev-fixtures.ts',
      'tests/load/**/*.js'
    ],
    rules: { 'no-console': 'off' }
  },

  // The specs say the number on purpose: they are what pins the statuses the code gives
  {
    files: ['**/*.spec.ts', 'tests/**/*.ts'],
    rules: {
      'no-restricted-syntax': ['error', processEnvBan, conversationStatusBan, prismaTransactionBan]
    }
  },

  // The single files allowed to read process.env
  {
    files: [
      'apps/web/lib/env.ts',
      'apps/widget/src/env.ts',
      'libs/core/platform/config/env.ts',
      'scripts/db-role-env.ts',
      'libs/core/database/testing/connection-urls.ts',
      'apps/api/src/testing/test-env.ts',
      'apps/worker/src/testing/test-env.ts',
      'libs/core/redis/src/testing/test-env.ts',
      'tests/helpers/env.ts',
      'libs/core/database/prisma/seed-env.ts',
      'prisma.config.ts',
      'libs/core/database/prisma.config.ts'
    ],
    rules: {
      'no-restricted-syntax': [
        'error',
        conversationStatusBan,
        prismaTransactionBan,
        ...httpStatusBans
      ]
    }
  },

  // PrismaService is the only place allowed to call $transaction, besides the development fixtures,
  // which run as the owner with no tenant context and no PrismaService
  {
    files: ['libs/core/database/src/prisma.service.ts', 'libs/core/database/src/dev-fixtures.ts'],
    rules: {
      'no-restricted-syntax': ['error', processEnvBan, conversationStatusBan, ...httpStatusBans]
    }
  },

  {
    ignores: ['**/dist/**', '**/generated/**', '**/.next/**', '**/coverage/**', '.nx/**']
  }
])
