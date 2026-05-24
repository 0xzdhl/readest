import { createMiddleware } from "@tanstack/react-start";
import { createDbClient } from "@/db/client";

/**
 * Initialize drizzle-orm
 */
export const databaseMiddleware = createMiddleware().server(
	async ({ next }) => {
		const db = createDbClient();
		return next({
			context: {
				db,
			},
		});
	},
);
