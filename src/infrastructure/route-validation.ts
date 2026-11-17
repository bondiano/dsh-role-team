import { formatRoute, messageOf } from "../domain/config.js";
import type {
	HostContext,
	Role,
	RoleTeamConfig,
	Route,
} from "../domain/types.js";
import { validateRuntimeRoute } from "./runtime-role.js";

/** Validate one configured route against the live LLM or agent runtime. */
export async function validateRoute(
	ctx: HostContext,
	role: Role,
	route: Route,
	signal?: AbortSignal,
): Promise<void> {
	if (route.runtime && route.runtime !== "native")
		return validateRuntimeRoute(ctx, route);
	const llm = ctx.get("llm");
	if (llm === undefined || llm === null) {
		throw new Error(
			"the LLM service is unavailable, so role routes cannot be validated",
		);
	}
	try {
		await llm.resolveCallConfig(
			{
				provider: route.provider,
				model: route.model,
				...(route.reasoningEffort === undefined
					? {}
					: { reasoningEffort: route.reasoningEffort }),
			},
			signal,
		);
	} catch (error) {
		throw new Error(
			`role ${role} route ${formatRoute(route)} is not usable: ${messageOf(error)}`,
		);
	}
}

/**
 * Validate multiple roles in parallel while preserving role-order error
 * reporting so callers always fail deterministically on the first bad role.
 */
export async function validateRoutesParallel(
	ctx: HostContext,
	roles: readonly Role[],
	config: RoleTeamConfig,
	signal?: AbortSignal,
): Promise<void> {
	const results = await Promise.allSettled(
		roles.map(async (role) => {
			const route = config.roles[role] ?? null;
			if (route !== null) await validateRoute(ctx, role, route, signal);
		}),
	);
	for (const result of results) {
		if (result.status === "rejected") throw result.reason;
	}
}
