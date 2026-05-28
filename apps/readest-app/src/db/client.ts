import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { env } from "@/env";
import * as schema from "./schema";

export function createDbClient() {
	const client = postgres(env.DATABASE_URL, {
		prepare: false,
		max: env.DATABASE_POOL_MAX,
		idle_timeout: 20,
	});

	const db = drizzle(client, {
		schema,
	});

	return db;
}

export type DbClient = ReturnType<typeof createDbClient>;
export type DbTransaction = DbClient["transaction"];
