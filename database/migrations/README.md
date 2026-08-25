# Migrations

**This directory is empty, and that is the current state rather than an
oversight.**

`../schema.sql` is the whole schema. No database exists that anybody has to
keep — `wrangler.jsonc` declares `DB` with no `database_id`, the Worker suite
applies the baseline into a fresh database for every run, and the end-to-end
suite deletes its database directory before rebuilding it. A change made in
`src/db/schema/` and regenerated into the baseline is therefore complete, and
there is nothing for a migration to carry it into.

That ends the day a database exists that cannot be thrown away. From then on
every change to a table that already exists needs a file here, for the reason
below.

## Why the baseline will not be enough

`IF NOT EXISTS` only ever helps an object that does not exist yet. Against a
database whose table is already there in an older shape, the statement is
**skipped and reported as success** — leaving the schema on the old definition
while the code assumes the new one. The two disagree silently, which is worse
than an error.

SQLite makes this sharper than most databases: it cannot `ALTER` a `CHECK`
constraint at all, and it cannot add one with `ALTER TABLE ... ADD COLUMN`
either. Changing or adding one means rebuilding the table — statements a
generator cannot infer, because only a person knows whether the existing rows
satisfy the new rule. See below for the shape that works here, which is not the
one most references give.

| Change | Baseline alone handles it? |
| --- | --- |
| A new table | Yes — `CREATE TABLE IF NOT EXISTS` does the work |
| A new index | Yes |
| A new value in a `CHECK` | **No** — the table exists, so nothing happens |
| A tightened bound in a `CHECK` | **No**, and existing rows may violate it |
| A new column | **No** |

## The one database that already survives a change

Not every database is thrown away today. The local one behind `npm run local`
persists in `.wrangler`, and `IF NOT EXISTS` skips it exactly as described
above — leaving the old shape under code that assumes the new one, where a
positional insert then supplies the wrong number of values.

Recreate it rather than repairing it:

```sh
rm -rf .wrangler
npm run db:setup:local
```

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
a table that was never old. With this directory empty the stamp step finds
nothing and exits, and it stays in `db:setup:local` precisely so that the first
file added here is stamped rather than applied twice.

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
each way and comparing them. While this directory is empty it says so and
compares nothing, because a comparison of the baseline against itself would pass
whatever either contained.

## Rebuilding a table, and why the usual recipe fails here

Every reference gives the same four steps: create `t__new`, copy the rows, drop
`t`, rename `t__new` to `t`. **On D1 that fails for any table another table
references**, and the reason is worth knowing before you need it.

`wrangler d1 execute --file` sends the whole file as one batch, and one batch is
one transaction. `PRAGMA foreign_keys = OFF` is a **no-op inside an open
transaction** — it is silently ignored and reads back as still on. So the
`DROP` orphans every child row, and there is no way to switch enforcement off
from inside the file:

```
BEGIN
PRAGMA foreign_keys = OFF     -- ignored; reads back as 1
DROP TABLE parent             -- FOREIGN KEY constraint failed
```

`PRAGMA defer_foreign_keys = ON` *is* honoured in a transaction, and is not
enough on its own: the `DROP` counts one deferred violation per orphaned row,
the `RENAME` restores the name without re-checking, and `COMMIT` fails.

What works is to rebuild **under the final name** and restore the rows last, so
the deferred count returns to zero before the commit:

```sql
PRAGMA defer_foreign_keys = ON;

CREATE TABLE `t__copy` AS SELECT <the old columns> FROM `t`;
DROP TABLE `t`;
CREATE TABLE `t` ( <the new definition, verbatim from ../schema.sql> );
CREATE UNIQUE INDEX `t_something_uq` ON `t` (...);   -- before the restore
INSERT INTO `t` (<the old columns>) SELECT <the old columns> FROM `t__copy`;
DROP TABLE `t__copy`;
```

Two things about that order are load-bearing. **The indexes come before the
restoring `INSERT`**, because a composite foreign key pointing at this table
needs the unique index backing its target to exist, or the insert fails with
`foreign key mismatch`. And **there is no `RENAME`**, which is what makes the
stored definition byte-identical to the baseline and lets the `CHECK`
constraints keep the `"t"."col"` qualification that drizzle-kit emits.

### Two more things that fail only at runtime

**Do not guard a rebuild with `IF NOT EXISTS`.** A guarded rebuild that ran
twice would skip the create and then copy rows out of a table that is already
the new one. What makes a migration run exactly once is the ledger row written
in the same batch, not a guard on the statement.

**`npm run db:schema:check` will not catch either mistake.** It replays
migrations with `sqlite3_exec` against an empty in-memory database — no
transaction, so `PRAGMA foreign_keys = OFF` appears to work, and no rows, so no
foreign key can be violated. It compares schema text, never data-migration
safety. The first migration to run against a real database is the first test of
this, which is why the shape above is written down rather than left to be
rediscovered.

## The ledger

`core_schema_migration` records what has run. The row is written **in the same
batch** as the migration it records, because one batch is one transaction:
recording afterwards would let a crash in between leave a database migrated but
unaware of it, and the next run would apply the same file again.

There is no checksum column. An editorial fix to a comment should not fail a
deploy, and the real protection is that an applied migration is never edited — a
correction is a new migration.
