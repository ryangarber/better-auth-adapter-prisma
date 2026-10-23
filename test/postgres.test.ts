import "temporal-polyfill/global";

import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { BetterAuthOptions } from "@better-auth/core";
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
	it("handles case-insensitive filters and treats LIKE metacharacters literally", async () => {
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
						mode: "insensitive",
					},
				],
			}),
		).toBe(1);
		expect(
			await adapter().count({
				model: "user",
				where: [{ field: "name", value: "AXXXB", mode: "insensitive" }],
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
						mode: "insensitive",
					},
				],
			}),
		).toBe(1);
	});
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
		const a = adapter({ advanced: { database: { joins: true } } });
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
	it("consumes a verification exactly once under concurrent requests", async () => {
		const a = adapter();
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
	});
	it("guards concurrent increments atomically", async () => {
		const a = adapter();
		const u = await a.create({ model: "user", data: { ...user(), score: 0 } });
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
	});
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
