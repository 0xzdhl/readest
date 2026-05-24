import { createMiddleware } from "@tanstack/react-start";
import { createAuth } from "@/auth/server";
import { databaseMiddleware } from "./database";

export const authMiddleware = createMiddleware({ type: "request" })
	.middleware([databaseMiddleware])
	.server(async ({ next, context }) => {
		const db = context.db;
		const auth = createAuth(db);
		return next({
			context: {
				auth,
			},
		});
	});
