/**
 * The database URL shared by the local setup and Worker launcher.
 *
 * A fresh checkout can use the repository's conventional Postgres container;
 * setting DATABASE_URL in .env or .env.local is how a developer chooses a
 * different local server without changing checked-in Wrangler configuration.
 */
export const DEFAULT_LOCAL_DATABASE_URL =
  'postgresql://postgres:postgres@localhost:5432/seb_backend'

export const localDatabaseUrl = () => process.env.DATABASE_URL || DEFAULT_LOCAL_DATABASE_URL
