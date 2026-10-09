# Deployment

How a commit gets from this repository to production, and which mechanical
checks stand between them. Companion to `DEPLOY.md`, which covers the Vercel /
Whop / Inngest account setup. This document covers the pipeline.

The promise this pipeline exists to protect: **a verified payment is never
lost.** Everything below is in service of that. An oversell is a chargeback, a
refund and a customer who paid for nothing.

---

## 1. The pipeline

`.github/workflows/ci.yml` — one workflow, five jobs, run on every push and
every pull request.

| Stage | Job | Command | Needs a database? | Gates merge? |
|---|---|---|---|---|
| 1 | `static` | `pnpm typecheck` | no | yes |
| 2 | `unit` | `pnpm test` | no (skips it) | yes |
| 3 | `lint` | not configured | no | **no** — see §3 |
| 4 | `integration` | `vitest run tests/concurrency.test.ts` | **yes, real Postgres** | yes |
| 5 | `build` | `pnpm build` | no | yes |

Every job starts from `pnpm install --frozen-lockfile`. If the lockfile does not
match `package.json`, the job fails before running anything — the pipeline
cannot be green against a dependency set nobody reviewed.

### What each stage catches

**Stage 1 — typecheck.** `tsc --noEmit` under `strict` and
`noUncheckedIndexedAccess`. Catches type errors, including the class of
"this is `T | undefined` and you did not handle it" that a payment path turns
into a lost order.

**Stage 2 — unit tests.** Money maths, pricing, the order state machine, HMAC
signature verification, crypto, id generation, security invariants. No
database, no network, no providers.

**Stage 3 — lint. Informational, not a gate.** See §3.

**Stage 4 — integration tests.** This is the stage that matters. It starts a
`postgres:16` service container and runs `tests/concurrency.test.ts` against it,
which asserts four things:

1. N concurrent reservations for fewer codes than requests **never oversell**.
2. The same webhook delivered ten times yields **exactly one** allocation.
3. A **delivered** code never returns to `AVAILABLE`.
4. **Revoke is terminal** — a revoked code never comes back, and a duplicate
   revoke is a no-op rather than a re-issue.

Every one of those is enforced by Postgres — `SELECT … FOR UPDATE SKIP LOCKED`,
the unique index on `InventoryCode.orderId`, the conditional `UPDATE` in the
release reaper. **A mocked Prisma client has no locks and no unique indexes, so
a mocked version of this suite would prove nothing at all.** This job uses a
real database. Do not let anyone "speed it up" by mocking Prisma here; the
whole value of the stage is that it is not mocked.

`DATABASE_URL` and `TEST_DATABASE_URL` are set to the same value on purpose.
`tests/helpers/db.ts` `resetDatabase` refuses to `TRUNCATE` anything unless the
two are byte-identical, which is the guard that stops a stray export from
pointing test truncation at a real database. Satisfying that guard is what lets
this job be safe.

**Stage 5 — build.** `prisma generate && next build`. `tsc` does not check
server/client component boundaries and does not resolve every route; `next
build` does. It catches a Server Component reaching for something Node-only,
and a route module that fails to load.

---

## 2. What blocks a merge

Configure all five jobs as **required status checks** in branch protection
(Settings → Branches → Branch protection rules → main).

A partial set defeats the purpose:

- `build` alone will not tell you the oversell guarantee is broken.
- `integration` alone will not tell you the app does not compile.
- `static` alone will not tell you anything about runtime behaviour.

Two properties of the workflow itself matter for this:

- **`concurrency` with `cancel-in-progress`.** A superseded run is cancelled
  rather than left in flight. Without it a stale run could finish after a newer
  one and the branch's overall state becomes ambiguous — which is precisely the
  condition under which someone merges without looking.
- **`permissions: contents: read`.** No job can write to the repository. CI has
  no ability to push a fix, close an issue, or push anything at all.

---

## 3. Lint is not a gate, and that is a deliberate gap

There is no ESLint in this repository. `pnpm-lock.yaml` contains **zero**
occurrences of `eslint`, `eslintrc`, `@typescript-eslint` or `typescript-eslint`,
and there is no ESLint config file.

`pnpm lint` is `next lint`, which with no config drops into an **interactive**
setup prompt. A CI runner has no TTY, so the prompt cannot be answered and
`next lint` exits 1 having linted nothing. Wiring it in as a required check
today would produce a permanently red pipeline gating on nothing — strictly
worse than no lint job, because it looks like coverage.

So stage 3 does two honest things instead:

1. Emits a `::warning` annotation on every run, so the absence of lint shows up
   in the checks list rather than being quietly forgotten.
2. Detects an ESLint config file and **runs `pnpm lint` as a real gate** if one
   appears. The day ESLint is added, the job starts enforcing with no edit to
   the workflow file.

To close the gap properly:

```bash
pnpm add -D eslint eslint-config-next
# create eslint.config.mjs
```

Both must be committed. Nothing in this pipeline introduces a dependency
automatically.

---

## 4. Production deploy is deliberately manual

**There is no deploy job in `ci.yml`.** Deployment is a human running
`vercel --prod` against a commit that has already passed all five stages.

That is the safe default, and it should stay the default until the following
exist as repository configuration:

1. A GitHub **environment** named `production` with required reviewers.
2. A deploy credential stored as an environment secret — not a repository
   secret, and never a value pasted into a workflow file.
3. A verified rollback path, documented and rehearsed.

Until all three exist, an auto-deploy on `push: main` means the first merge to
main publishes to production unattended. The stages above prove the code is
correct; they say nothing about whether the *production environment* is
configured — `assertProductionConfig()` runs at boot, so a deploy with a missing
`ENCRYPTION_KEY` goes green in the dashboard and 500s on every request. That is
a configuration failure, not a code failure, and no amount of CI on the commit
catches it.

The Vercel project's own Git integration may still create **preview**
deployments for pull requests. That is fine and desirable — previews are
throwaway and must use their own database and their own `CRON_SECRET`. The
danger is previews sharing production secrets; see the preview warning in
`DEPLOY.md` §3c.

### Deploy sequence

```bash
# 1. Confirm the exact commit is green on main.
git rev-parse HEAD

# 2. Apply migrations to the production database, if this commit has any.
pnpm db:deploy

# 3. Deploy that commit.
vercel --prod

# 4. Do NOT stop here. A green build is not a running app.
curl -s https://yourdomain.com/api/health | jq
```

Step 4 is not optional ceremony. See `DEPLOY.md` §7 for the full verification
checklist.

---

## 5. Migration discipline: Expand → Migrate → Verify → Contract

A migration is the one place in this system where a mistake destroys data
irreversibly. Redeem codes are AES-256-GCM encrypted with a key that has no
escrow and no recovery path. A dropped column is not a rollback.

**Never ship a destructive schema change in the same deploy as the code that
stops using it.** A running Vercel deployment is not one version — during a
rollout, old and new serverless instances serve traffic simultaneously. A
migration that assumes "nobody is running the old code any more" is wrong by
construction.

### Expand

Add the new column, table or index. **Additive only.** No renames, no drops, no
type narrowing, no `NOT NULL` without a default.

```sql
ALTER TABLE "Order" ADD COLUMN "statusV2" TEXT;
CREATE INDEX CONCURRENTLY "Order_statusV2_idx" ON "Order" ("statusV2");
```

Old code does not know this column exists and is entirely unaffected. Deploy
this **before** any code that uses it.

### Migrate

Ship code that **writes both** representations and **reads the new one with a
fallback to the old one**. Backfill in batches, from an application-level
script rather than one giant `UPDATE`:

```sql
-- batched, resumable, bounded
UPDATE "Order" SET "statusV2" = "status"
WHERE "statusV2" IS NULL AND id IN (
  SELECT id FROM "Order" WHERE "statusV2" IS NULL LIMIT 1000
);
```

Bounded batches keep the transaction short and keep locks off the rows the
checkout path is trying to touch. An unbounded backfill on a live payments
table is an outage with extra steps.

### Verify

Confirm the new representation is complete and correct **against real data**
before touching the old one. This is where stage 4 pays for itself: run the
integration suite against a database that has had both the migration and the
backfill applied, and confirm the four concurrency guarantees still hold. A
backfill that rewrites rows the allocation path reads is exactly the kind of
change that can reintroduce oversell, and a mocked test cannot see it.

Also compare counts, not just totals:

```sql
SELECT count(*) FROM "Order" WHERE "status" IS DISTINCT FROM "statusV2";
-- must be 0 before you consider the Contract phase
```

### Contract

Only once every deployed instance writes and reads the new representation, drop
the old one — in its **own** commit and its **own** deploy, days later.

```sql
ALTER TABLE "Order" DROP COLUMN "status";
```

Between Expand and Contract, **both** representations must be readable. Code
that reads only the new column will throw on rows the backfill has not reached
yet; code that writes only the new column will lose data if the old column is
still the source of truth somewhere.

### Rules that hold at every phase

- **Never rename a column. Add, backfill, drop.** A rename is a drop with a
  shorter fuse.
- **Never drop a column in the same release that stops using it.** Two deploys,
  two commits, and a rollback window between them.
- **Never run a destructive migration without a verified backup taken
  immediately before it**, and know how to restore it *before* you start.
- **Adding an index:** use `CREATE INDEX CONCURRENTLY` on anything the live
  checkout path reads, or you will block writes for the duration of the build.
- **`prisma migrate dev` is a development command.** It is interactive, it
  detects drift, and it can silently reset a database when it decides a reset is
  cheaper. In production, only `prisma migrate deploy` (`pnpm db:deploy`) ever
  runs, and it never prompts.
- **CI applies the schema with `prisma db push`, not `migrate deploy`.** That is
  correct: the suite truncates between tests, so migration history means nothing
  to it, and `db push` cannot fail a drift check against the previous run. The
  schema it applies is the same `schema.prisma` production uses.
- **A migration that is not in `prisma/migrations/` is not a migration.** If
  `pnpm db:deploy` is a silent no-op because the directory is missing, the
  database is empty and you will find out from a customer's 500, not from a
  failed command. See `DEPLOY.md` §4a.

---

## 6. Verifying this pipeline works

A pipeline nobody has watched fail is a pipeline nobody knows works. Before
trusting it:

1. Push a branch with a deliberate type error. `static` must go red.
2. Push a branch with a failing assertion in a unit suite. `unit` must go red.
3. **Push a branch that breaks the no-oversell guarantee** — for example, remove
   the `FOR UPDATE SKIP LOCKED` from `src/inventory/allocate.ts`. `integration`
   must go red, and the failing test must be
   *"N concurrent reservations for fewer codes than requests never oversell"*.
   This is the one test worth verifying deliberately, because it is the one that
   matters.
4. Push a branch that breaks a Server/Client boundary. `build` must go red while
   `static` stays green — confirming the stages are not redundant.

If step 3 does not go red, the pipeline is not doing its job, regardless of what
the green checks say.