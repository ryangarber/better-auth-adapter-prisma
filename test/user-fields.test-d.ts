import postgres from "@prisma/orm-postgres/runtime";
import { contractFromJson } from "@prisma/orm-postgres/static";
import { betterAuth } from "better-auth";
import { createAuthClient } from "better-auth/client";
import { inferAdditionalFields } from "better-auth/client/plugins";
import { expectTypeOf } from "vitest";
import { inferAuthClient, prismaUserFields } from "../src/client";
import { prismaAdapter } from "../src/index";
import type { Contract } from "./fixtures/contract";
import contractJson from "./fixtures/contract.json";
import { extension } from "./fixtures/schemas";

it("infers codec inputs and outputs through the server API", () => {
	const db = postgres({
		contract: contractFromJson<Contract>(contractJson),
		extensions: [extension.runtime],
	});
	const fields = prismaUserFields<Contract, "adapter_test", "User">()({
		profile: { type: "json", required: true },
		rich: { type: "json", required: false },
		lastSeen: { type: "date", required: false },
		nickname: { type: "string", fieldName: "role", required: false },
		secret: { type: "string", input: false, returned: false },
	});
	const legacyFields = prismaUserFields(db.orm.adapter_test.User)(
		fields.additionalFields,
	);
	expectTypeOf(legacyFields).toEqualTypeOf(fields);
	// @ts-expect-error Unknown namespace.
	prismaUserFields<Contract, "missing", "User">();
	// @ts-expect-error Unknown model.
	prismaUserFields<Contract, "adapter_test", "Missing">();
	const auth = fields.inferAuth(
		betterAuth({
			database: prismaAdapter(db),
			user: { additionalFields: fields.additionalFields },
		}),
	);
	expectTypeOf<typeof auth.$Infer.Session.user.profile>().toEqualTypeOf<{
		name: string;
		age: number;
	}>();
	expectTypeOf<
		NonNullable<typeof auth.$Infer.Session.user.rich>["count"]
	>().toEqualTypeOf<number>();
	expectTypeOf<typeof auth.$Infer.Session.user.nickname>().toEqualTypeOf<
		string | null | undefined
	>();
	// @ts-expect-error Secret is excluded from responses.
	auth.$Infer.Session.user.secret;
	prismaUserFields<Contract, "adapter_test", "User">()({
		// @ts-expect-error Unknown contract field.
		missing: { type: "json" },
	});
	const client = inferAuthClient<typeof fields>()(
		createAuthClient({
			plugins: [inferAdditionalFields<typeof auth>()],
		}),
	);
	expectTypeOf<
		typeof client.$Infer.Session.user.profile.age
	>().toEqualTypeOf<number>();
	expectTypeOf<typeof client.$Infer.Session.user.nickname>().toEqualTypeOf<
		string | null | undefined
	>();
	const atomSession = client.useSession.get();
	if (atomSession.data)
		expectTypeOf(atomSession.data.user.profile.age).toEqualTypeOf<number>();
	const sameClient = fields.inferClient(
		createAuthClient({ plugins: [inferAdditionalFields<typeof auth>()] }),
	);
	expectTypeOf<
		typeof sameClient.$Infer.Session.user.profile.age
	>().toEqualTypeOf<number>();
	// @ts-expect-error Secret is excluded from client responses.
	client.$Infer.Session.user.secret;
	async function checkClient() {
		const result = await client.signUp.email({
			email: "a@b.com",
			name: "Ada",
			password: "password",
			profile: { name: "Ada", age: "36" },
		});
		if (result.data)
			expectTypeOf(result.data.user.profile.age).toEqualTypeOf<number>();
		await client.updateUser({ profile: { name: "Ada", age: "37" } });
		await client.updateUser();
		// @ts-expect-error Codec inputs require a string age.
		await client.updateUser({ profile: { name: "Ada", age: 37 } });
		// @ts-expect-error Server-only field cannot be sent.
		await client.updateUser({ secret: "x" });
		// @ts-expect-error Required profile is missing.
		await client.signUp.email({
			email: "a@b.com",
			name: "Ada",
			password: "password",
		});
		await client.updateUser({
			profile: { name: "Ada", age: "37" },
			// @ts-expect-error Server-only fields remain excluded alongside valid fields.
			secret: "x",
		});
		const throwing = await client.signUp.email({
			email: "a@b.com",
			name: "Ada",
			password: "password",
			profile: { name: "Ada", age: "36" },
			fetchOptions: { throw: true },
		});
		expectTypeOf(throwing.user.profile.age).toEqualTypeOf<number>();
		const throwingSession = await client.getSession({}, { throw: true });
		if (throwingSession)
			expectTypeOf(throwingSession.user.profile.age).toEqualTypeOf<number>();
		const session = await client.getSession();
		if (session.data)
			expectTypeOf(session.data.user.profile.age).toEqualTypeOf<number>();
	}
	void checkClient;
	async function check() {
		const result = await auth.api.signUpEmail({
			body: {
				email: "a@b.com",
				name: "Ada",
				password: "password",
				profile: { name: "Ada", age: "36" },
			},
		});
		expectTypeOf(result.user.profile.age).toEqualTypeOf<number>();
		await auth.api.signUpEmail({
			body: {
				email: "a@b.com",
				name: "Ada",
				password: "password",
				// @ts-expect-error Codec input age is a string, even though the output is a number.
				profile: { name: "Ada", age: 36 },
			},
		});
		await auth.api.signUpEmail({
			// @ts-expect-error Required additional field is missing.
			body: { email: "a@b.com", name: "Ada", password: "password" },
		});
		await auth.api.updateUser({
			body: { profile: { name: "Ada", age: "37" } },
		});
		// @ts-expect-error Cannot set server-only fields.
		await auth.api.updateUser({ body: { secret: "x" } });
		const session = await auth.api.getSession({ headers: new Headers() });
		if (!session) throw new Error("Expected session");
		expectTypeOf(session.user.profile.age).toEqualTypeOf<number>();
		const headers = await auth.api.getSession({
			headers: new Headers(),
			returnHeaders: true,
		});
		if (!headers.response) throw new Error("Expected session");
		expectTypeOf(headers.response.user.profile.age).toEqualTypeOf<number>();
		const response = await auth.api.getSession({
			headers: new Headers(),
			asResponse: true,
		});
		expectTypeOf(response).toEqualTypeOf<Response>();
	}
	void check;

	expectTypeOf<typeof auth.$Infer.Session.user.lastSeen>().toEqualTypeOf<
		Date | null | undefined
	>();
});
