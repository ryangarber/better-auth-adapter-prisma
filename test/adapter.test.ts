import type { BetterAuthOptions } from "@better-auth/core";
import postgres from "@prisma/orm-postgres/runtime";
import { contractFromJson } from "@prisma/orm-postgres/static";
import { describe, expect, it, vi } from "vitest";
import { dateInput, dateOutput } from "../src/dates";
import { prismaAdapter, prismaUserFields } from "../src/index";
import type { Contract } from "./fixtures/contract";
import contractJson from "./fixtures/contract.json";
import { extension } from "./fixtures/schemas";

const real = postgres({
	contract: contractFromJson<Contract>(contractJson),
	extensions: [extension.runtime],
});
function fixture(coordinates: Record<string, string[]>) {
	const first = vi.fn(async () => null);
	const query = { where: () => query, first };
	const namespaces = Object.fromEntries(
		Object.entries(coordinates).map(([ns, models]) => [
			ns,
			{ models: Object.fromEntries(models.map((model) => [model, {}])) },
		]),
	);
	const orm = Object.fromEntries(
		Object.entries(coordinates).map(([ns, models]) => [
			ns,
			Object.fromEntries(models.map((model) => [model, query])),
		]),
	);
	// A minimal client double for exercising resolution without opening a connection.
	const client = {
		contract: { ...real.contract, domain: { namespaces } },
		orm,
	} as unknown as typeof real;
	return { client, first };
}
const where = [{ field: "id", value: "one" }];

describe("model resolution", () => {
	it.each(["User", "user"])(
		"resolves the original Prisma client convention: %s",
		async (model) => {
			const { client, first } = fixture({ auth: [model] });
			expect(
				await prismaAdapter(client)({}).findOne({ model: "user", where }),
			).toBeNull();
			expect(first).toHaveBeenCalledOnce();
		},
	);
	it("prefers an exact name when it exists", async () => {
		const { client } = fixture({ auth: ["User", "user"] });
		await expect(
			prismaAdapter(client)({}).findOne({ model: "user", where }),
		).resolves.toBeNull();
	});
	it("rejects namespace ambiguity and accepts an explicit namespace", async () => {
		const { client } = fixture({ auth: ["User"], public: ["User"] });
		await expect(
			prismaAdapter(client)({}).findOne({ model: "user", where }),
		).rejects.toThrow("ambiguous");
		await expect(
			prismaAdapter(client, { namespace: "auth" })({}).findOne({
				model: "user",
				where,
			}),
		).resolves.toBeNull();
	});
	it("pluralizes only when requested, as the original adapter does", async () => {
		const { client } = fixture({ public: ["Users"] });
		await expect(
			prismaAdapter(client)({}).findOne({ model: "user", where }),
		).rejects.toThrow("not found");
		await expect(
			prismaAdapter(client, { usePlural: true })({}).findOne({
				model: "user",
				where,
			}),
		).resolves.toBeNull();
	});
	it("honors Better Auth modelName and explicit exact coordinates", async () => {
		const { client } = fixture({ auth: ["PEOPLE"] });
		const options: BetterAuthOptions = { user: { modelName: "person" } };
		await expect(
			prismaAdapter(client, {
				models: { person: { namespace: "auth", model: "PEOPLE" } },
			})(options).findOne({ model: "user", where }),
		).resolves.toBeNull();
		await expect(
			prismaAdapter(client, { models: { person: "people" } })(options).findOne({
				model: "user",
				where,
			}),
		).rejects.toThrow("not found");
	});
	it("does not guess all-uppercase names or storage table names", async () => {
		const { client } = fixture({ public: ["USER"] });
		await expect(
			prismaAdapter(client)({}).findOne({ model: "user", where }),
		).rejects.toThrow("not found");
	});
});

describe("date adaptation", () => {
	const date = new Date("2026-09-12T12:34:56.789Z");
	it.each([
		"pg/timestamptz-temporal@1",
		"pg/timestamp-temporal@1",
		"pg/timestamptz-string@1",
		"pg/timestamp-string@1",
	])("round-trips a date through %s", (codec) => {
		expect(dateOutput(codec, dateInput(codec, date))).toEqual(date);
	});
	it("leaves custom codec values and nulls intact", () => {
		expect(dateInput("zod/json@1", date)).toBe(date);
		expect(dateOutput("zod/json@1", date)).toBe(date);
		expect(dateInput("pg/timestamptz-temporal@1", null)).toBeNull();
		expect(dateOutput("pg/timestamptz-temporal@1", null)).toBeNull();
	});
	it("converts arrays of dates used in filters", () => {
		const output = dateInput("pg/timestamptz-string@1", [date, null]);
		expect(output).toEqual([date.toISOString(), null]);
	});
});

it("requires the inferred fields to be installed on the auth instance", () => {
	const fields = prismaUserFields(real.orm.adapter_test.User)({
		profile: { type: "json" },
	});
	expect(() =>
		fields.inferAuth({ api: {}, $Infer: { Session: {} }, options: {} }),
	).toThrow("additionalFields");
});
