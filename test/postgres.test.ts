import "temporal-polyfill/global";

import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { BetterAuthOptions } from "@better-auth/core";
import type { DBAdapter, Where } from "@better-auth/core/db/adapter";
import { dataTypeParams } from "@prisma/orm-postgres/components/codec";
import { defineConfig } from "@prisma/orm-postgres/config";
import {
	isSqlDataType,
	renderSqlTypeName,
} from "@prisma/orm-postgres/family-contract/data-type";
import postgres from "@prisma/orm-postgres/runtime";
import { contractFromJson } from "@prisma/orm-postgres/static";
import { createPostgresBuiltinDataTypeLookup } from "@prisma/orm-postgres/target/data-types";
import { executeContractEmit } from "@prisma/orm-toolchain/cli/control-api";
import { betterAuth } from "better-auth";
import { prismaAdapter, prismaUserFields } from "../src/index";
import type { Contract } from "./fixtures/contract";
import staticContract from "./fixtures/contract.json";
import { extension } from "./fixtures/schemas";

const { ADAPTER_TEST_DATABASE_URL: url } = process.env;

// The suite runs against a matrix of Better Auth versions (see .github/workflows/check.yml).
// Features that Better Auth itself added after the peer range floor are gated here.
const betterAuthVersion: string = JSON.parse(
	readFileSync(
		new URL("../node_modules/@better-auth/core/package.json", import.meta.url),
		"utf8",
	),
).version;
const [major = 0, minor = 0] = betterAuthVersion.split(".").map(Number);
const atLeast = (wantMinor: number) => major > 1 || minor >= wantMinor;
// Case-insensitive `mode` on Where: Better Auth 1.6.
const supportsInsensitive = atLeast(6);
// Better Auth exposes consumeOne/incrementOne on the adapter from 1.7.
const supportsAtomic = atLeast(7);
// Spread into Where literals so they typecheck whether or not `mode` exists on Where.
const insensitive: Partial<Where> = { mode: "insensitive" } as Partial<Where>;
// The joins flag moved from `experimental.joins` (<= 1.6) to `advanced.database.joins` (1.7).
const joinOptions = {
	...(atLeast(7)
		? { advanced: { database: { joins: true } } }
		: { experimental: { joins: true } }),
} as BetterAuthOptions;
// Before 1.7, DBAdapter has no atomic primitives; give the (skipped) tests a loose shape.
type AtomicArgs = {
	model: string;
	where: Where[];
	increment?: Record<string, number>;
	set?: Record<string, unknown>;
};
type AtomicAdapter = DBAdapter extends {
	consumeOne: unknown;
	incrementOne: unknown;
}
	? DBAdapter
	: DBAdapter & {
			consumeOne(args: AtomicArgs): Promise<unknown>;
			incrementOne(args: AtomicArgs): Promise<unknown>;
		};
const quote = (value: string) => `"${value.replaceAll('"', '""')}"`;
const dataTypes = createPostgresBuiltinDataTypeLookup();

describe.skipIf(!url)("PostgreSQL integration", () => {
	const namespace = `ba_test_${randomUUID().replaceAll("-", "")}`;
	let directory: string;
	let db: ReturnType<typeof postgres>;
	const typedDb = postgres({
		contract: contractFromJson<Contract>(staticContract),
		extensions: [extension.runtime],
	});
	const fields = prismaUserFields(typedDb.orm.adapter_test.User)({
		profile: { type: "json", required: true },
		rich: { type: "json", required: false },
		lastSeen: { type: "date", required: false },
		role: { type: "string", required: false },
		score: { type: "number", required: false },
		secret: { type: "string", input: false, returned: false, required: false },
	});
	const options = {
		user: { additionalFields: fields.additionalFields },
	} satisfies BetterAuthOptions;
	const sql = (query: string) =>
		execFileSync(
			"psql",
			[url ?? "", "-X", "-v", "ON_ERROR_STOP=1", "-Atc", query],
			{
				encoding: "utf8",
			},
		).trim();
	const adapter = (
		extra: BetterAuthOptions = {},
		config: Parameters<typeof prismaAdapter>[1] = {},
	) => prismaAdapter(db, { namespace, ...config })({ ...options, ...extra });
	const user = (email = `${randomUUID()}@example.com`) => ({
		email,
		name: "Ada",
		emailVerified: false,
		createdAt: new Date(),
		updatedAt: new Date(),
		profile: { name: "Ada", age: "36" },
	});
	beforeAll(async () => {
		directory = await mkdtemp(join(process.cwd(), ".adapter-test-"));
		const psl = (
			await readFile(
				new URL("./fixtures/contract.prisma", import.meta.url),
				"utf8",
			)
		).replaceAll("adapter_test", namespace);
		await writeFile(join(directory, "contract.prisma"), psl);
		const emitted = await executeContractEmit({
			config: defineConfig({
				contract: join(directory, "contract.prisma"),
				extensions: [extension.control],
			}),
			cwd: process.cwd(),
		});
		const contractJson = JSON.parse(await readFile(emitted.files.json, "utf8"));
		db = postgres({
			contract: contractFromJson(contractJson),
			url: url ?? "",
			extensions: [extension.runtime],
			verifyMarker: false,
		});
		sql(`CREATE SCHEMA ${quote(namespace)}`);
		const tables = db.contract.storage.namespaces[namespace]?.entries["table"];
		if (!tables) throw new Error("Missing emitted tables");
		for (const [name, table] of Object.entries(tables)) {
			const columns = Object.entries(table.columns).map(([key, col]) => {
				const dataType = dataTypes.get(col.dataType);
				if (!dataType || !isSqlDataType(dataType))
					throw new Error(`Unknown SQL data type: ${col.dataType}`);
				const type = renderSqlTypeName(
					dataType,
					dataTypeParams(dataType, col.typeParams),
				);
				return `${quote(key)} ${type}${col.many ? "[]" : ""}${col.nullable ? "" : " NOT NULL"}`;
			});
			columns.push(`PRIMARY KEY (id)`);
			if (name === "People") columns.push("UNIQUE (email)");
			if (name === "login_sessions") columns.push("UNIQUE (token)");
			sql(
				`CREATE TABLE ${quote(namespace)}.${quote(name)} (${columns.join(", ")})`,
			);
		}
	}, 30_000);
	afterAll(async () => {
		await db?.close();
		await typedDb.close();
		sql(`DROP SCHEMA IF EXISTS ${quote(namespace)} CASCADE`);
		if (directory) await rm(directory, { recursive: true, force: true });
	});
	beforeEach(() =>
		sql(
			`TRUNCATE ${quote(namespace)}."People", ${quote(namespace)}.login_sessions, ${quote(namespace)}.accounts, ${quote(namespace)}.verifications, ${quote(namespace)}."CUSTOM_USERS"`,
		),
	);

	it("round-trips codec input/output, rich values, nullable fields and DateTime", async () => {
		const rich = {
			date: new Date("2026-01-02T03:04:05Z"),
			count: Number.MAX_SAFE_INTEGER,
			labels: { one: 1 },
		};
		const result = await adapter().create({
			model: "user",
			data: { ...user(), rich, lastSeen: rich.date },
		});
		expect(result).toMatchObject({
			profile: { name: "Ada", age: 36 },
			rich,
			role: null,
			lastSeen: rich.date,
		});
		expect(result["createdAt"]).toBeInstanceOf(Date);
		expect(
			sql(
				`SELECT jsonb_typeof(profile->'age') FROM ${quote(namespace)}."People"`,
			),
		).toBe("string");
		const found = await adapter().findOne({
			model: "user",
			where: [{ field: "id", value: result["id"] }],
		});
		expect(found).toEqual(result);
		const updated = await adapter().update({
			model: "user",
			where: [{ field: "id", value: result["id"] }],
			update: { profile: { name: "Grace", age: "40" }, rich: null },
		});
		expect(updated).toMatchObject({
			profile: { name: "Grace", age: 40 },
			rich: null,
		});
	});
	it("rejects invalid codec writes without storing a row", async () => {
		await expect(
			adapter().create({
				model: "user",
				data: { ...user(), profile: { name: "Bad", age: 36 } },
			}),
		).rejects.toThrow();
		expect(await adapter().count({ model: "user" })).toBe(0);
	});
	it("supports projection, sorting, pagination and bulk mutations", async () => {
		for (const name of ["C", "A", "B"])
			await adapter().create({ model: "user", data: { ...user(), name } });
		expect(
			await adapter().findMany({
				model: "user",
				select: ["name"],
				sortBy: { field: "name", direction: "asc" },
				offset: 1,
				limit: 1,
			}),
		).toEqual([{ name: "B" }]);
		expect(
			await adapter().updateMany({
				model: "user",
				where: [],
				update: { role: "reader" },
			}),
		).toBe(3);
		expect(
			await adapter().deleteMany({
				model: "user",
				where: [{ field: "role", value: "reader" }],
			}),
		).toBe(3);
	});
	it("updates/deletes at most one and returns null on missing updates", async () => {
		for (let i = 0; i < 2; i++)
			await adapter().create({ model: "user", data: user() });
		await adapter().update({
			model: "user",
			where: [{ field: "name", value: "Ada" }],
			update: { name: "Grace" },
		});
		expect(
			await adapter().count({
				model: "user",
				where: [{ field: "name", value: "Grace" }],
			}),
		).toBe(1);
		await adapter().delete({
			model: "user",
			where: [{ field: "name", value: "Ada" }],
		});
		expect(await adapter().count({ model: "user" })).toBe(1);
		expect(
			await adapter().update({
				model: "user",
				where: [{ field: "name", value: "Missing" }],
				update: { name: "No" },
			}),
		).toBeNull();
		await adapter().delete({
			model: "user",
			where: [{ field: "name", value: "Missing" }],
		});
	});
	it("preserves AND/OR grouping and handles null/empty-list predicates", async () => {
		await adapter().create({
			model: "user",
			data: { ...user(), role: "admin", score: 2 },
		});
		await adapter().create({
			model: "user",
			data: { ...user(), role: "reader", score: 3 },
		});
		expect(
			await adapter().count({
				model: "user",
				where: [
					{ field: "score", operator: "gt", value: 2 },
					{ field: "role", value: "admin", connector: "OR" },
					{ field: "role", value: "reader", connector: "OR" },
				],
			}),
		).toBe(1);
		expect(
			await adapter().count({
				model: "user",
				where: [{ field: "role", operator: "in", value: [] }],
			}),
		).toBe(0);
		expect(
			await adapter().count({
				model: "user",
				where: [{ field: "role", operator: "not_in", value: [null] as never }],
			}),
		).toBe(2);
		expect(
			await adapter().count({
				model: "user",
				where: [{ field: "rich", value: null }],
			}),
		).toBe(2);
	});
	it.skipIf(!supportsInsensitive)(
		"handles case-insensitive filters and treats LIKE metacharacters literally",
		async () => {
			await adapter().create({
				model: "user",
				data: { ...user(), name: "A%_\\B" },
			});
			await adapter().create({
				model: "user",
				data: { ...user(), name: "axxxb" },
			});
			expect(
				await adapter().count({
					model: "user",
					where: [
						{
							field: "name",
							operator: "contains",
							value: "%_\\",
							...insensitive,
						},
					],
				}),
			).toBe(1);
			expect(
				await adapter().count({
					model: "user",
					where: [{ field: "name", value: "AXXXB", ...insensitive }],
				}),
			).toBe(1);
			expect(
				await adapter().count({
					model: "user",
					where: [
						{
							field: "name",
							operator: "in",
							value: ["AXXXB"],
							...insensitive,
						},
					],
				}),
			).toBe(1);
		},
	);
	it("converts Date predicates through Prisma's built-in codec", async () => {
		const data = user();
		await adapter().create({ model: "user", data });
		expect(
			await adapter().count({
				model: "user",
				where: [
					{
						field: "createdAt",
						operator: "gte",
						value: new Date(data.createdAt.getTime() - 1000),
					},
				],
			}),
		).toBe(1);
	});
	it("honors custom model/field names and usePlural without guessing storage names", async () => {
		const custom = adapter(
			{
				user: {
					modelName: "person",
					fields: {
						name: "displayName",
						email: "emailAddress",
						emailVerified: "verified",
						image: "avatar",
						createdAt: "created",
						updatedAt: "updated",
					},
					additionalFields: {
						profile: { type: "json", fieldName: "profileData" },
					},
				},
			},
			{ usePlural: true, models: { persons: { namespace, model: "Person" } } },
		);
		const created = await custom.create({ model: "user", data: user() });
		expect(created).toMatchObject({
			name: "Ada",
			profile: { name: "Ada", age: 36 },
		});
		expect(created["createdAt"]).toBeInstanceOf(Date);
		expect(
			await custom.findOne({
				model: "user",
				where: [{ field: "name", value: "Ada" }],
				select: ["name", "profile"],
			}),
		).toEqual({ name: "Ada", profile: { name: "Ada", age: 36 } });
	});
	it("rolls back transactions and binds every operation to the transaction client", async () => {
		const transactional = adapter({}, { transaction: true });
		await expect(
			transactional.transaction(async (tx) => {
				await tx.create({ model: "user", data: user() });
				expect(await tx.count({ model: "user" })).toBe(1);
				throw new Error("rollback");
			}),
		).rejects.toThrow("rollback");
		expect(await adapter().count({ model: "user" })).toBe(0);
	});
	it("joins via Better Auth FK metadata without relation property names", async () => {
		const a = adapter(joinOptions);
		const u = await a.create({ model: "user", data: user() });
		await a.create({
			model: "session",
			data: {
				userId: u["id"],
				token: "token",
				createdAt: new Date(),
				updatedAt: new Date(),
				expiresAt: new Date(Date.now() + 10000),
			},
		});
		expect(
			await a.findOne({
				model: "session",
				where: [{ field: "token", value: "token" }],
				join: { user: true },
			}),
		).toMatchObject({ user: { profile: { age: 36 } } });
		expect(
			await a.findOne({
				model: "user",
				where: [{ field: "id", value: u["id"] }],
				join: { session: { limit: 1 } },
			}),
		).toMatchObject({ session: [{ token: "token" }] });
	});
	it.skipIf(!supportsAtomic)(
		"consumes a verification exactly once under concurrent requests",
		async () => {
			const a = adapter() as AtomicAdapter;
			await a.create({
				model: "verification",
				data: {
					identifier: "one-time",
					value: "secret",
					createdAt: new Date(),
					updatedAt: new Date(),
					expiresAt: new Date(Date.now() + 10000),
				},
			});
			const results = await Promise.all(
				Array.from({ length: 8 }, () =>
					a.consumeOne({
						model: "verification",
						where: [{ field: "identifier", value: "one-time" }],
					}),
				),
			);
			expect(results.filter(Boolean)).toHaveLength(1);
		},
	);
	it.skipIf(!supportsAtomic)(
		"guards concurrent increments atomically",
		async () => {
			const a = adapter() as AtomicAdapter;
			const u = await a.create({
				model: "user",
				data: { ...user(), score: 0 },
			});
			const results = await Promise.all(
				Array.from({ length: 4 }, () =>
					a.incrementOne({
						model: "user",
						where: [
							{ field: "id", value: u["id"] },
							{ field: "score", operator: "lt", value: 1 },
						],
						increment: { score: 1 },
					}),
				),
			);
			expect(results.filter(Boolean)).toHaveLength(1);
		},
	);
	it.skipIf(!supportsAtomic)(
		"consumes only one row of a non-unique match and returns it",
		async () => {
			const a = adapter() as AtomicAdapter;
			const verification = (value: string) => ({
				model: "verification",
				data: {
					identifier: "shared",
					value,
					createdAt: new Date(),
					updatedAt: new Date(),
					expiresAt: new Date(Date.now() + 10000),
				},
			});
			await a.create(verification("a"));
			await a.create(verification("b"));
			const where = [{ field: "identifier", value: "shared" }];
			const consumed = await a.consumeOne({ model: "verification", where });
			expect(consumed).toMatchObject({ identifier: "shared" });
			expect((consumed as { expiresAt: unknown }).expiresAt).toBeInstanceOf(
				Date,
			);
			expect(await a.count({ model: "verification", where })).toBe(1);
			expect(
				await a.consumeOne({
					model: "verification",
					where: [{ field: "identifier", value: "missing" }],
				}),
			).toBeNull();
		},
	);
	it.skipIf(!supportsAtomic)(
		"increments from null, applies negative deltas and sets fields in one step",
		async () => {
			const a = adapter() as AtomicAdapter;
			const u = await a.create({ model: "user", data: user() });
			const where = [{ field: "id", value: u["id"] }];
			expect(
				await a.incrementOne({
					model: "user",
					where,
					increment: { score: 3 },
					set: { role: "admin" },
				}),
			).toMatchObject({ score: 3, role: "admin", profile: { age: 36 } });
			expect(
				await a.incrementOne({
					model: "user",
					where,
					increment: { score: -2 },
				}),
			).toMatchObject({ score: 1 });
			expect(
				await a.incrementOne({
					model: "user",
					where: [...where, { field: "score", operator: "gt", value: 5 }],
					increment: { score: 1 },
				}),
			).toBeNull();
		},
	);
	it.skipIf(!supportsAtomic)(
		"runs atomic primitives inside Better Auth transactions",
		async () => {
			const transactional = adapter({}, { transaction: true });
			const u = await transactional.create({
				model: "user",
				data: { ...user(), score: 0 },
			});
			const where = [{ field: "id", value: u["id"] }];
			await expect(
				transactional.transaction(async (tx) => {
					await (tx as unknown as AtomicAdapter).incrementOne({
						model: "user",
						where,
						increment: { score: 1 },
					});
					throw new Error("rollback");
				}),
			).rejects.toThrow("rollback");
			expect(
				await transactional.findOne({ model: "user", where }),
			).toMatchObject({ score: 0 });
			await transactional.transaction((tx) =>
				(tx as unknown as AtomicAdapter).incrementOne({
					model: "user",
					where,
					increment: { score: 1 },
				}),
			);
			expect(
				await transactional.findOne({ model: "user", where }),
			).toMatchObject({ score: 1 });
		},
	);
	it("runs Better Auth signup, session reads and updates with inferred codec types", async () => {
		const auth = fields.inferAuth(
			betterAuth({
				...options,
				database: prismaAdapter(db, { namespace, transaction: true }),
				secret: "test-only-secret-at-least-thirty-two-characters",
				baseURL: "http://localhost:3000",
				emailAndPassword: { enabled: true },
			}),
		);
		const rich = { date: new Date(), count: 7, labels: { x: 1 } };
		const result = await auth.api.signUpEmail({
			body: {
				email: "ada@example.com",
				name: "Ada",
				password: "correct horse battery staple",
				rich,
				profile: { name: "Ada", age: "36" },
			},
			returnHeaders: true,
		});
		expect(result.response.user.profile.age).toBe(36);
		expect(result.response.user.rich).toEqual(rich);
		const cookies = result.headers
			.getSetCookie()
			.map((cookie) => cookie.split(";")[0])
			.join("; ");
		const headers = new Headers({ cookie: cookies });
		expect((await auth.api.getSession({ headers }))?.user.profile.age).toBe(36);
		await auth.api.updateUser({
			headers,
			body: { profile: { name: "Ada", age: "37" } },
		});
		expect((await auth.api.getSession({ headers }))?.user.profile.age).toBe(37);
	});
});
