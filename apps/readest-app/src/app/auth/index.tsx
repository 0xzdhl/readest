import { createFileRoute } from "@tanstack/react-router";
import z from "zod";
import { AuthComponent } from "@/components/Auth";

const authSearchSchema = z.object({
	redirect: z.string().default("/library").catch("/library"),
});

export const Route = createFileRoute("/auth/")({
	validateSearch: authSearchSchema,
	component: AuthComponent,
});
