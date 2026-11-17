import { clampInt, cloneJson, isPlainObject, LIMITS, serializeRoute, } from "../domain/config.js";
import { stateFor, updateConfigState } from "./state.js";
/**
 * Shared helper that validates `configEditor` + `fiber.entry`, applies a
 * mutation to the persisted configuration, and updates live in-memory state.
 */
async function editPluginConfig(ctx, mutate) {
    const editor = ctx.get("configEditor");
    if (editor === undefined || editor === null) {
        throw new Error("the configuration editor is unavailable; edit the role-team row in the profile cordis.patch.yml instead");
    }
    const entry = ctx.fiber?.entry;
    if (entry === undefined || entry === null) {
        throw new Error("the role-team plugin is not mounted through the Loader; its configuration cannot be persisted");
    }
    let nextConfig;
    await editor.edit(entry, (current) => {
        const next = isPlainObject(current) ? cloneJson(current) : {};
        mutate(next);
        nextConfig = next;
        return next;
    });
    updateConfigState(ctx, nextConfig);
    return nextConfig;
}
/**
 * Persist one role route through the profile configuration editor.
 * `mode = "reset"` deletes the override (falling back to recommended default);
 * `mode = "inherit"` writes `null` (following the caller's session model).
 */
export async function saveRoleRoute(ctx, role, route, mode = route === null ? "reset" : "set") {
    return editPluginConfig(ctx, (next) => {
        const roles = isPlainObject(next.roles) ? next.roles : {};
        if (mode === "reset") {
            Reflect.deleteProperty(roles, role);
        }
        else if (mode === "inherit" || route === null) {
            roles[role] = null;
        }
        else {
            roles[role] = serializeRoute(route);
        }
        if (Object.keys(roles).length === 0)
            Reflect.deleteProperty(next, "roles");
        else
            next.roles = roles;
    });
}
/**
 * Persist one role's ordered fallback chain. An empty array deletes the
 * override so the role keeps no fallback routes.
 */
export async function saveRoleFallbacks(ctx, role, routes) {
    return editPluginConfig(ctx, (next) => {
        const fallbacks = isPlainObject(next.fallbacks) ? next.fallbacks : {};
        if (routes.length === 0) {
            Reflect.deleteProperty(fallbacks, role);
        }
        else {
            fallbacks[role] = routes.map(serializeRoute);
        }
        if (Object.keys(fallbacks).length === 0)
            Reflect.deleteProperty(next, "fallbacks");
        else
            next.fallbacks = fallbacks;
    });
}
/**
 * Persist numeric team settings (`maxRounds`, `maxPlanPasses`, `childMaxDepth`).
 */
export async function saveTeamSettings(ctx, patch) {
    const current = stateFor(ctx).config;
    return editPluginConfig(ctx, (next) => {
        if (patch.maxRounds !== undefined) {
            next.maxRounds = clampInt(patch.maxRounds, 1, LIMITS.maxRounds, current.maxRounds);
        }
        if (patch.maxPlanPasses !== undefined) {
            next.maxPlanPasses = clampInt(patch.maxPlanPasses, 1, LIMITS.maxPlanPasses, current.maxPlanPasses);
        }
        if (patch.childMaxDepth !== undefined) {
            next.childMaxDepth = clampInt(patch.childMaxDepth, 0, LIMITS.maxChildDepth, current.childMaxDepth);
        }
    });
}
