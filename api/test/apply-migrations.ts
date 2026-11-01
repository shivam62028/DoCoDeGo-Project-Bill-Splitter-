import { applyD1Migrations } from 'cloudflare:test'
import { env } from 'cloudflare:workers'

// Applies every file in api/migrations to the test database before the tests run.
await applyD1Migrations(env.DB, env.TEST_MIGRATIONS)
