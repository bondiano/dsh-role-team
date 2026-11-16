import type { IncomingMessage, ServerResponse } from "node:http";
import { saveRoleRoute, saveTeamSettings } from "./commands.js";
import {
	cloneJson,
	isPlainObject,
	isRole,
	messageOf,
	normalizeRoute,
	PLAN_SESSION_ROUTE,
	ROLE_NAMES,
	ROLES_SETTINGS_ROUTE,
	roleTeamSnapshot,
	RUN_STATE_ROUTE,
	validateRoute,
} from "./config.js";
import { claimPlanSession, runStateOf, stateFor } from "./state.js";
import type { HostContext, Role } from "./types.js";

/** Report whether the browser half is present in the composed client graph. */
function clientModuleStatus(ctx: HostContext) {
	try {
		const graph = ctx.get("clientModules")?.graph?.();
		if (graph === undefined) return { clientModule: false };
		const entry = graph.entries.find(
			(candidate) => candidate.id === "@local/dsh-role-team",
		);
		return {
			clientModule: entry !== undefined,
			...(entry === undefined ? {} : { url: entry.url }),
			rev: graph.rev,
		};
	} catch {
		return { clientModule: false };
	}
}

/** Whether a hostname names this machine. */
function isLoopbackHostname(hostname: string): boolean {
	return (
		hostname === "127.0.0.1" ||
		hostname === "localhost" ||
		hostname === "::1" ||
		hostname === "[::1]"
	);
}

/** Whether a Host header names a loopback authority. */
function isLoopbackAuthority(authority: string): boolean {
	try {
		return isLoopbackHostname(new URL(`http://${authority}`).hostname);
	} catch {
		return false;
	}
}

/** Admit only same-origin loopback requests to the settings route. */
export function trustedRoleRouteRequest(request: Request): boolean {
	if (request.headers.get("sec-fetch-site") === "cross-site") return false;
	if (!isLoopbackAuthority(request.headers.get("host") ?? "")) return false;
	const origin = request.headers.get("origin");
	if (origin === null || origin === "") return true;
	try {
		return isLoopbackHostname(new URL(origin).hostname);
	} catch {
		return false;
	}
}

/** Render one settings-route response. */
export function roleRouteJson(value: unknown, status = 200): Response {
	return new Response(JSON.stringify(value), {
		status,
		headers: {
			"content-type": "application/json; charset=utf-8",
			"cache-control": "no-store",
		},
	});
}

/**
 * Collect route validation errors in parallel when requested or when external
 * runtimes are configured.
 */
async function collectValidationErrors(
	ctx: HostContext,
	rawConfig: unknown,
	validateAll: boolean,
	signal?: AbortSignal,
): Promise<Partial<Record<Role, string>>> {
	const snapshot = roleTeamSnapshot(rawConfig);
	const errors: Partial<Record<Role, string>> = {};
	await Promise.all(
		ROLE_NAMES.map(async (role) => {
			const route = snapshot.roles[role].route;
			if (route === null) return;
			const isExternal =
				route.runtime !== undefined && route.runtime !== "native";
			if (!validateAll && !isExternal) return;
			try {
				await validateRoute(ctx, role, route, signal);
			} catch (error) {
				errors[role] = messageOf(error);
			}
		}),
	);
	return errors;
}

/**
 * Resolve the effective raw configuration for an HTTP request, preferring
 * live persisted state when `rawConfig` is omitted or empty.
 */
function effectiveRawConfig(ctx: HostContext, rawConfig?: unknown): unknown {
	if (isPlainObject(rawConfig) && Object.keys(rawConfig).length > 0) {
		return rawConfig;
	}
	const live = stateFor(ctx).rawConfig;
	if (isPlainObject(live) && Object.keys(live).length > 0) {
		return live;
	}
	const entryConfig = ctx.fiber?.entry?.options?.config;
	if (isPlainObject(entryConfig) && Object.keys(entryConfig).length > 0) {
		return entryConfig;
	}
	return rawConfig ?? live ?? {};
}

/**
 * Serve GET and POST for the role settings page.
 */
export async function handleRolesRoute(
	ctx: HostContext,
	request: Request,
	rawConfig?: unknown,
): Promise<Response> {
	if (!trustedRoleRouteRequest(request))
		return roleRouteJson({ ok: false, error: "forbidden" }, 403);
	const method = request.method.toUpperCase();
	if (method === "GET") {
		const effective = effectiveRawConfig(ctx, rawConfig);
		let validateAll = false;
		try {
			validateAll = new URL(request.url).searchParams.get("validate") === "1";
		} catch {
			validateAll = false;
		}
		const validationErrors = await collectValidationErrors(
			ctx,
			effective,
			validateAll,
			request.signal,
		);
		return roleRouteJson({
			...roleTeamSnapshot(effective, validationErrors),
			client: clientModuleStatus(ctx),
		});
	}
	if (method === "HEAD")
		return new Response(null, {
			status: 200,
			headers: { "cache-control": "no-store" },
		});
	if (method !== "POST") {
		return new Response("method not allowed", {
			status: 405,
			headers: { allow: "GET, HEAD, POST" },
		});
	}
	if (request.headers.get("x-role-team-request") !== "1") {
		return roleRouteJson({ ok: false, error: "forbidden" }, 403);
	}
	const declared = Number(request.headers.get("content-length") ?? "0");
	if (Number.isFinite(declared) && declared > 8192) {
		return roleRouteJson({ ok: false, error: "payload too large" }, 413);
	}
	let body;
	try {
		const text = await request.text();
		if (text.length > 8192)
			return roleRouteJson({ ok: false, error: "payload too large" }, 413);
		body = JSON.parse(text);
	} catch {
		return roleRouteJson({ ok: false, error: "invalid JSON body" }, 400);
	}
	if (!isPlainObject(body))
		return roleRouteJson({ ok: false, error: "invalid request body" }, 400);
	try {
		if (body.action === "config") {
			const next = await saveTeamSettings(ctx, {
				maxRounds: body.maxRounds,
				maxPlanPasses: body.maxPlanPasses,
				childMaxDepth: body.childMaxDepth,
			});
			return roleRouteJson(roleTeamSnapshot(next));
		}
		const role = typeof body.role === "string" ? body.role.toLowerCase() : "";
		if (!isRole(role))
			return roleRouteJson({ ok: false, error: "unknown role" }, 400);
		if (body.action === "reset") {
			const next = await saveRoleRoute(ctx, role, null, "reset");
			return roleRouteJson(roleTeamSnapshot(next));
		}
		if (
			body.action === "inherit" ||
			body.route === null ||
			(typeof body.route === "string" &&
				body.route.trim().toLowerCase() === "inherit") ||
			(isPlainObject(body.route) && body.route.inherit === true)
		) {
			const next = await saveRoleRoute(ctx, role, null, "inherit");
			return roleRouteJson(roleTeamSnapshot(next));
		}
		const parsed = normalizeRoute(body.route);
		if (parsed.error !== undefined || parsed.route === null) {
			return roleRouteJson(
				{
					ok: false,
					error: parsed.error ?? "a concrete provider/model route is required",
				},
				400,
			);
		}
		await validateRoute(ctx, role, parsed.route, request.signal);
		const next = await saveRoleRoute(ctx, role, parsed.route, "set");
		return roleRouteJson(roleTeamSnapshot(next));
	} catch (error) {
		return roleRouteJson({ ok: false, error: messageOf(error) }, 400);
	}
}

/** Read one HTTP request body with a hard size limit. */
function readRoleRouteBody(
	req: IncomingMessage,
	limit: number,
): Promise<string> {
	return new Promise((resolve, reject) => {
		const chunks: Buffer[] = [];
		let size = 0;
		req.on("data", (chunk) => {
			size += chunk.length;
			if (size > limit) {
				const error = Object.assign(new Error("payload too large"), {
					code: "ROLE_TEAM_PAYLOAD_TOO_LARGE",
				});
				reject(error);
				req.destroy();
				return;
			}
			chunks.push(chunk);
		});
		req.on("end", () => {
			resolve(Buffer.concat(chunks).toString("utf8"));
		});
		req.on("error", reject);
	});
}

/** Adapt the settings route to the Node HTTP carrier. */
export async function handleRolesHttp(
	ctx: HostContext,
	req: IncomingMessage,
	res: ServerResponse,
	rawConfig?: unknown,
): Promise<void> {
	try {
		const method = (req.method ?? "GET").toUpperCase();
		const body =
			method === "GET" || method === "HEAD"
				? undefined
				: await readRoleRouteBody(req, 8192);
		const headers = new Headers();
		for (const [name, value] of Object.entries(req.headers)) {
			if (value !== undefined)
				headers.set(name, Array.isArray(value) ? value.join(",") : value);
		}
		const authority = isLoopbackAuthority(req.headers.host ?? "")
			? req.headers.host!
			: "127.0.0.1";
		const request = new Request(
			`http://${authority}${req.url ?? ROLES_SETTINGS_ROUTE}`,
			{
				method,
				headers,
				...(body === undefined ? {} : { body }),
			},
		);
		const response = await handleRolesRoute(
			ctx,
			request,
			effectiveRawConfig(ctx, rawConfig),
		);
		res.statusCode = response.status;
		response.headers.forEach((value, name) => {
			res.setHeader(name, value);
		});
		res.end(Buffer.from(await response.arrayBuffer()));
	} catch (error) {
		const status =
			error instanceof Error &&
			"code" in error &&
			error.code === "ROLE_TEAM_PAYLOAD_TOO_LARGE"
				? 413
				: 400;
		res.statusCode = status;
		res.setHeader("content-type", "application/json; charset=utf-8");
		res.setHeader("cache-control", "no-store");
		res.end(JSON.stringify({ ok: false, error: messageOf(error) }));
	}
}

/**
 * Serve the live run state of one tool call over the plugin API (GET),
 * or cancel an active background run from the timeline card (POST / ?cancel=1).
 */
export function handleRunStateRequest(
	ctx: HostContext,
	request: Request,
): Response {
	if (!trustedRoleRouteRequest(request))
		return roleRouteJson({ ok: false, error: "forbidden" }, 403);
	let callId = "";
	let cancelRequested = false;
	try {
		const url = new URL(request.url);
		const rest = url.pathname.slice(RUN_STATE_ROUTE.length);
		callId = rest === "" ? "" : decodeURIComponent(rest.replace(/^\//, ""));
		cancelRequested =
			request.method.toUpperCase() === "POST" ||
			(url.searchParams.get("action") === "cancel" &&
				request.headers.get("x-role-team-request") === "1");
	} catch {
		return roleRouteJson({ ok: false, error: "bad request" }, 400);
	}
	if (callId === "" || callId.includes("/"))
		return roleRouteJson({ ok: false, error: "unknown run" }, 404);
	if (cancelRequested) {
		if (request.headers.get("x-role-team-request") !== "1") {
			return roleRouteJson({ ok: false, error: "forbidden" }, 403);
		}
		const cancelled = stateFor(ctx).background?.cancelById(callId);
		if (cancelled === undefined)
			return roleRouteJson({ ok: false, error: "unknown run" }, 404);
		return roleRouteJson({ ok: true, run: cloneJson(cancelled) });
	}
	const run =
		stateFor(ctx).background?.publicState(callId) ??
		runStateOf(callId, ctx) ??
		runStateOf(callId);
	if (run === undefined)
		return roleRouteJson({ ok: false, error: "unknown run" }, 404);
	return roleRouteJson({ ok: true, run: cloneJson(run) });
}

/** Serve the browser's claim of one freshly created plan session. */
export function handlePlanSessionRequest(
	ctx: HostContext,
	request: Request,
): Response {
	if (!trustedRoleRouteRequest(request))
		return roleRouteJson({ ok: false, error: "forbidden" }, 403);
	let sessionId = "";
	try {
		const url = new URL(request.url);
		const rest = url.pathname.slice(PLAN_SESSION_ROUTE.length);
		sessionId = rest === "" ? "" : decodeURIComponent(rest.replace(/^\//, ""));
	} catch {
		return roleRouteJson({ ok: false, error: "bad request" }, 400);
	}
	if (sessionId === "" || sessionId.includes("/"))
		return roleRouteJson({ ok: false, error: "unknown session" }, 404);
	if (!claimPlanSession(ctx, sessionId))
		return roleRouteJson({ ok: false, error: "unknown session" }, 404);
	return roleRouteJson({ ok: true, sessionId });
}
