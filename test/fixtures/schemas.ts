import type { CodecTypes } from "prisma-orm-extension-zod/codec-types";
import {
	createZodExtension,
	defineZodSchema,
} from "prisma-orm-extension-zod/column-types";
import { z } from "zod";

const Profile = z.object({
	name: z.string(),
	age: z.string().transform(Number),
});
const Rich = z.object({
	date: z.date(),
	count: z.int(),
	labels: z.record(z.string(), z.number()),
});
const schemas = {
	Profile: defineZodSchema(Profile),
	Rich: defineZodSchema(Rich),
};
export type SchemaTypes = CodecTypes<typeof schemas>;
export const extension: ReturnType<typeof createZodExtension> =
	createZodExtension(schemas, { module: "./schemas", export: "SchemaTypes" });
