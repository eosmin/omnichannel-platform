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

export default defineConfig([
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  ...nx.configs['flat/base'],
  ...nx.configs['flat/typescript'],
  importX.flatConfigs.recommended,
  importX.flatConfigs.typescript,

  {
    files: ['**/*.ts', '**/*.tsx', '**/*.cts', '**/*.mts'],
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
      'no-restricted-syntax': ['error', processEnvBan, conversationStatusBan, prismaTransactionBan],

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

  // Scripts and the seed are allowed to print; everything else uses Pino
  {
    files: ['scripts/**/*.ts', 'libs/core/database/prisma/seed.ts', 'tests/load/**/*.js'],
    rules: { 'no-console': 'off' }
  },

  // The single files allowed to read process.env
  {
    files: [
      'apps/web/lib/env.ts',
      'apps/widget/src/env.ts',
      'libs/core/platform/config/env.ts',
      'prisma.config.ts',
      'libs/core/database/prisma.config.ts'
    ],
    rules: {
      'no-restricted-syntax': ['error', conversationStatusBan, prismaTransactionBan]
    }
  },

  // PrismaService is the only place allowed to call $transaction
  {
    files: ['libs/core/database/src/prisma.service.ts'],
    rules: {
      'no-restricted-syntax': ['error', processEnvBan, conversationStatusBan]
    }
  },

  {
    ignores: ['**/dist/**', '**/generated/**', '**/.next/**', 'coverage/**', '.nx/**']
  }
])
