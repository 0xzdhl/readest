/**
 * Test helper: drive a TanStack file-route's middleware chain + handler the
 * way the framework runtime does, without spinning up the full router.
 *
 * Middleware in our codebase is created via `createMiddleware()` from
 * `@tanstack/react-start`. The returned object exposes `.options.server`
 * (the function the user passed) and `.options.middleware` (the deps).
 * This helper walks the dep tree, deduplicates, then runs each middleware
 * in dependency order, threading the accumulated `context` through `next`.
 *
 * Each middleware either:
 *   - returns the result of `await next({ context: {...} })` (the
 *     accumulated context is then visible to downstream middleware/handler),
 *   - or returns a Response directly to short-circuit (e.g. 401 in
 *     protectedMiddleware) — `next` is not called and the chain unwinds with
 *     that Response.
 *
 * Typing is intentionally loose (`unknown` / `Record<string, unknown>`) —
 * TanStack's actual route + middleware types are highly generic and would
 * require mirroring half the framework's type tree. Test call sites cast
 * to `RouteLike` to get past TypeScript; the runtime contract is what
 * matters.
 */

type NextFn = (passed?: { context?: Record<string, unknown> }) => Promise<unknown>;

interface MiddlewareLike {
  options: {
    server: (args: {
      request: Request;
      context: Record<string, unknown>;
      next: NextFn;
    }) => unknown;
    middleware?: ReadonlyArray<MiddlewareLike>;
  };
}

export interface RouteLike {
  options: {
    server?: {
      middleware?: ReadonlyArray<MiddlewareLike>;
      handlers?: Record<
        string,
        (args: {
          request: Request;
          params: Record<string, string>;
          context: Record<string, unknown>;
        }) => unknown
      >;
    };
  };
}

const flattenMiddleware = (mws: ReadonlyArray<MiddlewareLike>): MiddlewareLike[] => {
  const seen = new Set<MiddlewareLike>();
  const out: MiddlewareLike[] = [];
  const visit = (m: MiddlewareLike) => {
    if (seen.has(m)) return;
    seen.add(m);
    for (const dep of m.options.middleware ?? []) visit(dep);
    out.push(m);
  };
  mws.forEach(visit);
  return out;
};

export async function runRoute(
  route: RouteLike,
  method: string,
  args: { request: Request; params?: Record<string, string> },
): Promise<Response> {
  const server = route.options.server;
  if (!server) throw new Error('Route has no server config');
  const handler = server.handlers?.[method];
  if (!handler) throw new Error(`No handler for method ${method}`);

  const flat = flattenMiddleware(server.middleware ?? []);
  let context: Record<string, unknown> = {};
  let i = 0;

  const next: NextFn = async (passed) => {
    if (passed?.context) context = { ...context, ...passed.context };
    if (i === flat.length) {
      return handler({
        request: args.request,
        params: args.params ?? {},
        context,
      });
    }
    const mw = flat[i++]!;
    return mw.options.server({ request: args.request, context, next });
  };

  return (await next()) as Response;
}
