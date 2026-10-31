import type { BetterAuthOptions } from "@better-auth/core";
import type {
	AdapterFactoryCustomizeAdapterCreator,
	DBAdapter,
	DBAdapterDebugLogOption,
	JoinConfig,
	Where,
} from "@better-auth/core/db/adapter";
import { createAdapterFactory } from "@better-auth/core/db/adapter";
import { BetterAuthError } from "@better-auth/core/error";
import type { Contract } from "@prisma/orm-postgres/contract/types";
import type { SqlStorage } from "@prisma/orm-postgres/family-contract/types";
import { and, or } from "@prisma/orm-postgres/orm-client";
import {
	type AnyExpression,
	BinaryExpr,
	FunctionCallExpr,
} from "@prisma/orm-postgres/relational-core/ast";
import type { PostgresClient } from "@prisma/orm-postgres/runtime";
import { dateInput, dateOutput } from "./dates";

export type {
	PrismaUserFields,
	TypedPrismaAuth,
	TypedPrismaClient,
} from "./user-fields";
export { prismaUserFields } from "./user-fields";

export interface Prisma8Config {
	/** PostgreSQL is the supported Prisma 8 target. */
	provider?: "postgresql";
	/** Same default as the original Prisma adapter: false. */
	usePlural?: boolean;
	/** Same default as the original Prisma adapter: false. */
	transaction?: boolean;
	debugLogs?: DBAdapterDebugLogOption;
	/** Restrict model lookup to this contract namespace. Otherwise names must be unambiguous. */
	namespace?: string;
	/** Keys are Better Auth model names after modelName/usePlural; values are exact contract coordinates. */
	models?: Record<string, string | { namespace: string; model: string }>;
}

type Row = Record<string, unknown>;
type Field = Record<string, ((value?: unknown) => AnyExpression) | undefined>;
type Fields = Record<string, Field | undefined>;
// Better Auth dispatches model and field names dynamically. Keep that erased boundary here;
// the public client argument remains checked against Prisma's real contract/client types.
interface Query {
	where(predicate: (fields: Fields) => AnyExpression): Query;
	select(...fields: string[]): Query;
	orderBy(predicate: (fields: Fields) => AnyExpression): Query;
	limit(value: number): Query;
	offset(value: number): Query;
	forUpdate(): Query;
	create(data: unknown): Promise<Row>;
	first(): Promise<Row | null>;
	all(): PromiseLike<Row[]>;
	aggregate(
		build: (aggregate: { count(): unknown }) => { total: unknown },
	): Promise<{ total: number }>;
	update(data: unknown): Promise<Row | null>;
	updateAndCount(data: unknown): Promise<number>;
	delete(): Promise<Row | null>;
	deleteAndCount(): Promise<number>;
}

function call(
	field: Field | undefined,
	method: string,
	value?: unknown,
): AnyExpression {
	const fn = field?.[method];
	if (!fn)
		throw new BetterAuthError(
			`Prisma 8 field does not support ${method}; check the field name and codec traits.`,
		);
	return fn(value);
}

const escapeLike = (value: string) => value.replace(/[\\%_]/g, "\\$&");

/** Convert Better Auth's AND-group AND (OR-group) semantics, as in the Prisma 7 adapter. */
export function prismaWhere(
	fields: Fields,
	where: readonly Where[] = [],
): AnyExpression {
	function condition(w: Where): AnyExpression {
		const field = fields[w.field];
		const op = w.operator ?? "eq";
		if (w.value === null && (op === "eq" || op === "ne")) {
			return call(field, op === "eq" ? "isNull" : "isNotNull");
		}
		// `mode` exists on Where from Better Auth 1.6; older versions never send it.
		const insensitive =
			(w as { mode?: "sensitive" | "insensitive" }).mode === "insensitive";
		if (op === "in" || op === "not_in") {
			if (!Array.isArray(w.value))
				throw new BetterAuthError(`${op} requires an array`);
			const values = w.value.filter((value) => value != null);
			if (!values.length) return op === "in" ? or() : and();
			if (insensitive && values.every((value) => typeof value === "string")) {
				const expr = or(
					...values.map((value) => condition({ ...w, operator: "eq", value })),
				);
				return op === "not_in" ? expr.not() : expr;
			}
			return call(field, op === "in" ? "in" : "notIn", values);
		}
		const method = op === "ne" ? "neq" : op;
		let expr: AnyExpression;
		if (op === "contains" || op === "starts_with" || op === "ends_with") {
			if (typeof w.value !== "string")
				throw new BetterAuthError(`${op} requires a string`);
			const pattern = `${op === "starts_with" ? "" : "%"}${escapeLike(w.value)}${op === "ends_with" ? "" : "%"}`;
			expr = call(field, "like", pattern);
		} else {
			expr = call(field, method, w.value);
		}
		if (insensitive && typeof w.value === "string") {
			// Build from the codec-aware ORM predicate: never interpolate identifiers or values.
			if (!(expr instanceof BinaryExpr))
				throw new BetterAuthError("Expected a Prisma binary predicate");
			expr = new BinaryExpr(
				expr.op,
				FunctionCallExpr.of("lower", [expr.left]),
				FunctionCallExpr.of("lower", [expr.right]),
			);
		}
		return expr;
	}
	const conjunction = where.filter((w) => w.connector !== "OR").map(condition);
	const disjunction = where.filter((w) => w.connector === "OR").map(condition);
	return and(
		...conjunction,
		...(disjunction.length ? [or(...disjunction)] : []),
	);
}

export function prismaAdapter<C extends Contract<SqlStorage>>(
	db: Pick<PostgresClient<C>, "orm" | "contract" | "transaction">,
	config: Prisma8Config = {},
): (options: BetterAuthOptions) => DBAdapter<BetterAuthOptions> {
	if (db.contract.target !== "postgres")
		throw new BetterAuthError(
			"This adapter requires a Prisma 8 PostgreSQL contract",
		);
	const resolve = (name: string): { namespace: string; model: string } => {
		const mapped = config.models?.[name];
		const model = typeof mapped === "string" ? mapped : (mapped?.model ?? name);
		const namespace =
			typeof mapped === "object" ? mapped.namespace : config.namespace;
		const candidates = Object.entries(db.contract.domain.namespaces).flatMap(
			([ns, domain]) =>
				namespace !== undefined && ns !== namespace
					? []
					: Object.keys(domain.models ?? {}).map((key) => ({
							namespace: ns,
							model: key,
						})),
		);
		const exact = candidates.filter((c) => c.model === model);
		const matches = exact.length
			? exact
			: mapped === undefined
				? candidates.filter(
						(c) => c.model[0]?.toLowerCase() + c.model.slice(1) === model,
					)
				: [];
		if (matches.length !== 1)
			throw new BetterAuthError(
				`Prisma 8 model '${name}' ${matches.length ? "is ambiguous" : "was not found"}. Configure namespace/models using contract model names (not storage table names).`,
			);
		const match = matches[0];
		if (!match) throw new BetterAuthError("Prisma model resolution failed");
		return match;
	};

	return (options) => {
		const build = (
			orm: unknown,
			inTransaction: boolean,
		): DBAdapter<BetterAuthOptions> => {
			const creator: AdapterFactoryCustomizeAdapterCreator = ({
				getFieldName,
				schema,
				getDefaultModelName,
			}) => {
				const dateCodec = (model: string, field: string) => {
					if (
						!Object.entries(
							schema[getDefaultModelName(model)]?.fields ?? {},
						).some(
							([key, attr]) =>
								(attr.fieldName ?? key) === field && attr.type === "date",
						)
					)
						return undefined;
					const coordinate = resolve(model);
					const type =
						db.contract.domain.namespaces[coordinate.namespace]?.models[
							coordinate.model
						]?.fields?.[field]?.type;
					return type?.kind === "scalar" ? type.codecId : undefined;
				};
				const inputData = (model: string, data: unknown) =>
					Object.fromEntries(
						Object.entries(data as Row).map(([field, value]) => [
							field,
							dateInput(dateCodec(model, field), value),
						]),
					);
				const outputRow = (model: string, row: Row): Row =>
					Object.fromEntries(
						Object.entries(row).map(([field, value]) => [
							field,
							dateOutput(dateCodec(model, field), value),
						]),
					);
				const queryOn =
					(orm: unknown) => (model: string, where?: readonly Where[]) => {
						const coordinate = resolve(model);
						const surface = orm as Record<string, Record<string, Query>>;
						const collection =
							surface[coordinate.namespace]?.[coordinate.model];
						if (!collection)
							throw new BetterAuthError(
								`Prisma 8 collection ${coordinate.namespace}.${coordinate.model} is unavailable`,
							);
						return where === undefined
							? collection
							: collection.where((fields) =>
									prismaWhere(
										fields,
										where.map((w) => ({
											...w,
											value: dateInput(
												dateCodec(model, w.field),
												w.value,
											) as Where["value"],
										})),
									),
								);
					};
				const query = queryOn(orm);
				// Run in the current transaction, or open one: row locks need a transaction to hold them.
				const atomically = <R>(
					fn: (q: typeof query) => Promise<R>,
				): Promise<R> =>
					inTransaction
						? fn(query)
						: db.transaction((tx) => fn(queryOn(tx.orm)));
				// Lock the first matching row (SELECT ... FOR UPDATE) and address it by id. A concurrent
				// caller blocks on the lock, then PostgreSQL re-evaluates its predicate against the
				// committed row: a consumed row no longer exists and a guard that no longer holds no
				// longer matches, so the racer gets null.
				const lockOne = async (
					q: typeof query,
					model: string,
					where: readonly Where[],
				) => {
					const row = await q(model, where).forUpdate().first();
					if (!row) return null;
					const id = getFieldName({ model, field: "id" });
					return {
						row,
						byId: q(model, [
							{
								field: id,
								value: row[id] as Where["value"],
								operator: "eq",
								connector: "AND",
							},
						]),
					};
				};
				const selectQuery = (q: Query, model: string, select?: string[]) =>
					select?.length
						? q.select(...select.map((field) => getFieldName({ model, field })))
						: q;
				// Join using Better Auth's resolved FK metadata, so relation-property naming is irrelevant.
				const joinRows = async (
					rows: Row[],
					model: string,
					join?: JoinConfig,
				) => {
					rows = rows.map((row) => outputRow(model, row));
					if (!join) return rows;
					return Promise.all(
						rows.map(async (row) => {
							const result = { ...row };
							for (const [joinedModel, attr] of Object.entries(join)) {
								const value = row[getFieldName({ model, field: attr.on.from })];
								let joined: Row[] = [];
								if (value != null) {
									joined = await query(joinedModel, [
										{
											field: getFieldName({
												model: joinedModel,
												field: attr.on.to,
											}),
											value: value as Where["value"],
										},
									])
										.limit(
											attr.relation === "one-to-one" ? 1 : (attr.limit ?? 100),
										)
										.all();
								}
								joined = joined.map((row) => outputRow(joinedModel, row));
								result[joinedModel] =
									attr.relation === "one-to-one" ? (joined[0] ?? null) : joined;
							}
							return result;
						}),
					);
				};
				return {
					async create({ model, data, select }) {
						return outputRow(
							model,
							await selectQuery(query(model), model, select).create(
								inputData(model, data),
							),
						) as typeof data;
					},
					async findOne<T>({
						model,
						where,
						select,
						join,
					}: {
						model: string;
						where: Where[];
						select?: string[] | undefined;
						join?: JoinConfig | undefined;
					}) {
						const row = await selectQuery(
							query(model, where),
							model,
							select,
						).first();
						return (
							row ? (await joinRows([row], model, join))[0] : null
						) as T | null;
					},
					async findMany<T>({
						model,
						where,
						select,
						limit,
						offset,
						sortBy,
						join,
					}: {
						model: string;
						where?: Where[] | undefined;
						select?: string[] | undefined;
						limit: number;
						offset?: number | undefined;
						sortBy?: { field: string; direction: "asc" | "desc" } | undefined;
						join?: JoinConfig | undefined;
					}) {
						let q = selectQuery(query(model, where), model, select).limit(
							limit,
						);
						if (offset !== undefined) q = q.offset(offset);
						if (sortBy)
							q = q.orderBy((fields) =>
								call(
									fields[getFieldName({ model, field: sortBy.field })],
									sortBy.direction,
								),
							);
						return (await joinRows(await q.all(), model, join)) as T[];
					},
					count: async ({ model, where }) =>
						(await query(model, where).aggregate((a) => ({ total: a.count() })))
							.total,
					async update<T>({
						model,
						where,
						update,
					}: {
						model: string;
						where: Where[];
						update: T;
					}) {
						const row = await query(model, where).update(
							inputData(model, update),
						);
						return (row ? outputRow(model, row) : null) as T | null;
					},
					updateMany: ({ model, where, update }) =>
						query(model, where).updateAndCount(inputData(model, update)),
					async delete({ model, where }) {
						await query(model, where).delete();
					},
					deleteMany: ({ model, where }) =>
						query(model, where).deleteAndCount(),
					// Native atomic primitives, used by Better Auth 1.7+ (and required by 1.7.0-1.7.2).
					// Prisma's ORM binds update values as parameters, so `SET n = n + $delta` isn't
					// expressible, and its single-row update/delete don't re-check the predicate.
					// Instead, lock the row and mutate it by id in the same transaction.
					consumeOne: <T>({
						model,
						where,
					}: {
						model: string;
						where: Where[];
					}) =>
						atomically(async (q) => {
							const target = await lockOne(q, model, where);
							const row = target && (await target.byId.delete());
							return (row ? outputRow(model, row) : null) as T | null;
						}),
					incrementOne: <T>({
						model,
						where,
						increment,
						set,
					}: {
						model: string;
						where: Where[];
						increment: Record<string, number>;
						set?: Record<string, unknown> | undefined;
					}) =>
						atomically(async (q) => {
							const target = await lockOne(q, model, where);
							if (!target) return null;
							const update: Row = { ...set };
							for (const [field, delta] of Object.entries(increment)) {
								const current = target.row[field] ?? 0;
								if (typeof current !== "number" || !Number.isFinite(delta))
									throw new BetterAuthError(
										`incrementOne requires a numeric '${field}' field and a finite delta`,
									);
								update[field] = current + delta;
							}
							const row = await target.byId.update(inputData(model, update));
							return (row ? outputRow(model, row) : null) as T | null;
						}),
					options: config,
				};
			};
			return createAdapterFactory({
				config: {
					adapterId: "prisma-8",
					adapterName: "Prisma 8 Adapter",
					usePlural: config.usePlural ?? false,
					debugLogs: config.debugLogs ?? false,
					supportsJSON: true,
					supportsArrays: true,
					supportsDates: true,
					supportsBooleans: true,
					supportsUUIDs: true,
					supportsNumericIds: true,
					transaction:
						config.transaction && !inTransaction
							? (callback) =>
									db.transaction((tx) => callback(build(tx.orm, true)))
							: false,
				},
				adapter: creator,
			})(options);
		};
		return build(db.orm, false);
	};
}

export { prismaAdapter as prisma8Adapter };
