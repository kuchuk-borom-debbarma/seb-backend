# Migrations

`../schema.sql` is the **baseline**: every table in its current shape, guarded
with `IF NOT EXISTS` so applying it twice is harmless. This directory holds the
**changes** — what has to happen to a database that already exists.

Both are needed, and the reason is worth stating once.

## Why the baseline is not enough

`IF NOT EXISTS` only ever helps an object that does not exist yet. Against a
database whose table is already there in an older shape, the statement is
**skipped and reported as success** — leaving the schema on the old definition
while the code assumes the new one. The two disagree silently, which is worse
than an error.

SQLite makes this sharper than most databases: it cannot `ALTER` a `CHECK`
constraint at all. Changing one means creating a new table, copying every row,
dropping the old and renaming — four statements a generator cannot infer,
because only a person knows whether the existing rows satisfy the new rule.

| Change | Baseline alone handles it? |
| --- | --- |
| A new table | Yes — `CREATE TABLE IF NOT EXISTS` does the work |
| A new index | Yes |
| A new value in a `CHECK` | **No** — the table exists, so nothing happens |
| A tightened bound in a `CHECK` | **No**, and existing rows may violate it |
| A new column | **No** |

## The two paths

```
new database      npm run db:setup:local     baseline, then every migration
                                             recorded as applied without
                                             running it

existing database npm run db:migrate         whatever is not yet recorded,
                                             in order
```

A fresh database **stamps** rather than replays: the baseline already contains
every migration's effect, so re-running a table rebuild against it would rebuild
a table that was never old.

## Writing one

Name it `NNNN-kebab-case.sql`, taking the next number. The number is the order
and the filename is the identity — `scripts/migrate.mjs` refuses anything else,
because an unpadded number sorts wrongly and would run out of sequence.

Then, in the same commit:

1. Change the Drizzle schema in `src/db/schema/`.
2. `npm run db:schema:generate` to regenerate the baseline.
3. Write the migration by hand.
4. Add a `rewind` entry in `scripts/check-migrations.mjs` describing how to age
   the baseline back past your change. Without it the check cannot build a
   database that predates the migration, and it fails rather than skipping.

`npm run db:schema:check` then proves the two paths agree by building a database
each way and comparing them. That check is the only thing standing between a
baseline and a migration chain that have quietly diverged.

### Two things that fail only at runtime

**Do not guard a rebuild with `IF NOT EXISTS`.** A guarded rebuild that ran
twice would skip the create and then copy rows out of a table that is already
the new one. What makes a migration run exactly once is the ledger row written
in the same batch, not a guard on the statement.

**Do not let a `CHECK` qualify its own table.** `CHECK("t"."col" > 0)` does not
survive `ALTER TABLE ... RENAME` — the reference keeps the temporary name and
the table becomes unusable. Write `CHECK("col" > 0)`.

## The ledger

`core_schema_migration` records what has run. The row is written **in the same
batch** as the migration it records, because one batch is one transaction:
recording afterwards would let a crash in between leave a database migrated but
unaware of it, and the next run would apply the same file again.

There is no checksum column. An editorial fix to a comment should not fail a
deploy, and the real protection is that an applied migration is never edited — a
correction is a new migration.
