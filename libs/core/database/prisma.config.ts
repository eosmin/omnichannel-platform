import 'dotenv-flow/config'
import { defineConfig } from 'prisma/config'

export default defineConfig({
  schema: 'libs/core/database/prisma/schema.prisma',
  migrations: {
    path: 'libs/core/database/prisma/migrations',
    seed: 'tsx --tsconfig libs/core/database/tsconfig.json libs/core/database/prisma/seed.ts'
  },
  datasource: {
    // CLI only: bypasses PgBouncer and connects as the owner role
    url: process.env['DIRECT_DATABASE_URL']
  }
})
