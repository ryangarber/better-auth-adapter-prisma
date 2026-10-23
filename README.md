# Better Auth adapter for Prisma 8

A PostgreSQL adapter for **Prisma 8.0.0-rc.20** and **Better Auth ^1.7.5**, based on the behavior of Better Auth's Prisma 7 adapter. Uses Prisma 8's contract-driven ORM, including extension codecs, instead of the legacy Prisma Client API.

Supports CRUD, filtering, selections, pagination, ordering, transactions, joins, numeric/UUID identifiers, and additional fields. PostgreSQL is the supported target; this package does not implement the separate MongoDB API or claim SQLite/MySQL support.

## Install

```sh
pnpm add @ryangarber/better-auth-adapter-prisma better-auth @better-auth/core @prisma/orm-postgres@8.0.0-rc.20 temporal-polyfill
```

Prisma RC versions are pinned because their query and generated-type APIs change between releases. The adapter does not create a database connection or close your client; pass your application's existing client with its runtime extensions registered.

```ts
// auth.ts
import "temporal-polyfill/global"; // Required by Prisma DateTime codecs on runtimes without Temporal.
import { betterAuth } from "better-auth";
import { prismaAdapter } from "@ryangarber/better-auth-adapter-prisma";
import { db } from "./prisma/db";

export const auth = betterAuth({
  database: prismaAdapter(db),
  emailAndPassword: { enabled: true },
});
```

Both `prismaAdapter` and `prisma8Adapter` name the same factory. This adapter does not currently support Better Auth CLI emission. Author and emit your `contract.prisma`, then provision it using Prisma's normal database/migration workflow.

A complete test contract containing the four authentication models is in [test/fixtures/contract.prisma](test/fixtures/contract.prisma).

## Names and defaults

| Setting | Default | Behavior |
| --- | --- | --- |
| `provider` | `"postgresql"` | PostgreSQL contract required. |
| `usePlural` | `false` | Same as the original adapter. When enabled, Better Auth appends `s`, including to custom `modelName` values. |
| Model lookup | Exact, then lower-first alias | `user` resolves to contract model `user` or `User`, matching Prisma 7 delegate naming. Exact matches take precedence. No general case folding or English pluralization. |
| `namespace` | Unspecified | Search contract namespaces; reject ambiguous model names. |
| `models` | Unspecified | Map a resolved Better Auth name to an exact contract model name or `{ namespace, model }`. |
| `transaction` | `false` | Same as the original adapter. Enable to bind Better Auth transaction callbacks to Prisma transactions. |
| `debugLogs` | `false` | Better Auth adapter logging. |

`user.modelName`, `session.modelName`, plugin model names, built-in `fields` mappings, and additional-field `fieldName` mappings remain Better Auth options. They refer to **Prisma model and model-field names**. Prisma itself resolves storage names from `@@map` and `@map`; SQL table capitalization is not guessed by the adapter.

```ts
betterAuth({
  database: prismaAdapter(db, {
    namespace: "auth",
    usePlural: true,
    transaction: true,
    models: {
      persons: { namespace: "auth", model: "AuthPerson" },
      sessions: "LoginSession",
    },
  }),
  user: {
    modelName: "person", // becomes "persons" with usePlural
    fields: { name: "displayName" },
    additionalFields: {
      profile: { type: "json", fieldName: "profileData" },
    },
  },
});
```

Explicit `models` mappings are exact: a misspelling fails rather than silently falling back. The same resolution applies inside transactions and joins. Joins use Better Auth's foreign-key metadata and separate ORM queries, so they do not require guessed Prisma relation-property names. They are not single-statement SQL joins; use a suitable transaction/isolation strategy if your application needs a consistent snapshot across those reads.


## Addtional fields and extensions

Declare additional fields in both the Prisma contract and Better Auth. The adapter passes their values through Prisma's ORM so the configured codec handles encoding and decoding. It does not JSON-stringify, clone nested values, or deserialize extension fields itself. Nullable fields, arrays, enums, branded values, and structured JSON retain their Prisma codec behavior.

### Example: Zod extension

For example, you can use [the Zod extension](https://github.com/ryangarber/prisma-orm-extension-zod) for typed `additionalFields`:

Assuming you already have a Zod schema called `Profile` in your `User` model:

```ts
// prisma/schemas.ts
import { z } from "zod";

export const Profile = z.object({
  name: z.string(),
  age: z.string().transform(Number),
});
```

```prisma

model User {
  ...
  profile  zod.Json("Profile")
}
```

#### Server-side

You must use `type: "json"`. Better Auth treats this as generic record, allowing you to wrap the field with `prismaUserFields`:

```ts
import { betterAuth } from "better-auth";
import { prismaAdapter } from "@ryangarber/better-auth-adapter-prisma";
import { prismaUserFields } from "@ryangarber/better-auth-adapter-prisma/client";
import type { Contract } from "./prisma/contract";
import { db } from "./prisma/db";

export const userFields = prismaUserFields<Contract, "public", "User">()({
  profile: { type: "json", required: true },
});

export const auth = userFields.inferAuth(betterAuth({
  database: prismaAdapter(db),
  emailAndPassword: { enabled: true },
  user: { additionalFields: userFields.additionalFields },
}));

const result = await auth.api.signUpEmail({
  body: {
    email: "ada@example.com",
    name: "Ada",
    password: "a sufficiently long password",
    profile: { name: "Ada", age: "36" }, // Write input: string.
  },
});
// result.user.profile.age is number.

type User = typeof auth.$Infer.Session.user; // User["profile"] is { name: string; age: number }.
```

This types `signUpEmail` and `updateUser` bodies, full user objects returned by server endpoints, and `auth.$Infer.Session.user`.
It returns the same auth object at runtime, and checks that its `additionalFields` object was installed on that instance.

#### Client-side

Import the runtime-free, browser-safe `/client` wrapper and import your `userFields` as a type for the same typed fields on the client:

```ts
import { createAuthClient } from "better-auth/client";
import { inferAdditionalFields } from "better-auth/client/plugins";
import { inferAuthClient } from "@ryangarber/better-auth-adapter-prisma/client";
import type { auth, userFields } from "./auth";

export const authClient = inferAuthClient<typeof userFields>()(createAuthClient({
  plugins: [inferAdditionalFields<typeof auth>()],
}));

await authClient.signUp.email({
  email: "ada@example.com",
  name: "Ada",
  password: "a sufficiently long password",
  profile: { name: "Ada", age: "36" },
});
const session = await authClient.getSession();
session.data?.user.profile.age; // age is number
```

This preserves codec input/output types on signup, updates, session results, and `$Infer.Session`.

> Note that these helpers do not change Better Auth's hook/context types or plugin-defined input bodies, nor do they change how the fields are serialized.
> This means that fields that are not supported in basic JSON requests (`bigint`, `Map`, etc.) may not deserialize the way you expect.

## Technical details

The adapter tries to match the official Prisma 7 adapter exactly:

- Equality, inequality, comparisons, `in`/`not_in`, and string contains/prefix/suffix filters are supported. Case-insensitive string filters use database `lower(...)`; LIKE wildcard characters are escaped as literals.
- AND conditions are combined with the OR group, matching the original adapter. Null list members are removed; an empty `in` matches nothing and an empty `not_in` matches everything.
- Operations use Prisma's codec-aware predicates. A codec must advertise the comparison/order traits needed by a query. Codec, database, and constraint errors propagate.
- Single-row updates/deletes affect at most one match. Missing updates return `null`; missing deletes are no-ops. Better Auth guards empty single-row mutation predicates.
- Bulk updates/deletes use affected-row counts. Better Auth's built-in compare-and-swap fallbacks implement guarded increments and single-use consumption using these atomic operations. Prisma's single-row read-then-write methods are not advertised as atomic guarded operations.
- Built-in PostgreSQL `DateTime`/Temporal and date-string codecs are adapted on Better Auth `date` fields to/from JavaScript `Date`, including filters. Timestamp-without-time-zone values are treated as UTC. Custom extension codecs are not converted.

## Development and verification

```sh
pnpm install
pnpm typecheck
pnpm typecheck:contract  # Generated Prisma declarations, with skipLibCheck disabled.
pnpm lint
pnpm build
pnpm test

# Explicit opt-in; creates a unique ba_test_* schema and drops it in finally/afterAll.
ADAPTER_TEST_DATABASE_URL=postgresql://localhost:5432/postgres pnpm test
```

Live tests require PostgreSQL and `psql`. They emit the fixture contract, provision isolated tables, exercise real codecs and Better Auth, and clean up their schema. They cover storage names, mappings, rich values, different input/output types, date conversion, filtering, pagination, joins, rollback, concurrent consumption/increments, and signup/session/update. They do not test Prisma migrations or production contract signing; the isolated fixture runtime disables marker verification.

The ordinary project check retains the scaffold's `skipLibCheck` setting because Better Auth's optional platform declarations have unrelated compatibility issues. The separate contract check validates all generated Prisma field maps and their dependencies without that setting, and the type tests assert concrete input/output types and rejected invalid inputs.

Regenerate the committed type fixture with `node test/fixtures/emit.ts`. Generated files should not be edited manually.
