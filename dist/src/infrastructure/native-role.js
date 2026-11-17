import { clip, formatRoute, messageOf, oneLine, ROLE_LABELS, textOf, } from "../domain/config.js";
/**
 * Start one native DSH subagent activation, stream its live activity, enforce
 * abort semantics, and always dispose the child handle.
 */
export async function runNativeRole(ctx, config, { role, route, childName, prompt, parent, signal, cwd, onUpdate, onChild, }) {
    const subagents = ctx.get("subagents");
    if (subagents === undefined || subagents === null) {
        throw new Error("role team needs the subagent service; mount @deepseek-ai/dsh-subagent and @deepseek-ai/dsh-subagent-spawn-in-process");
    }
    const provider = subagents.getProvider("spawn");
    if (provider === undefined || provider === null) {
        throw new Error('role team needs the "spawn" subagent provider; mount @deepseek-ai/dsh-subagent-spawn-in-process');
    }
    if (signal !== undefined && signal.aborted)
        throw new Error("role team was cancelled");
    const startedAt = Date.now();
    const agentOptions = route === null
        ? undefined
        : {
            provider: route.provider,
            model: route.model,
            ...(route.reasoningEffort === undefined
                ? {}
                : { reasoningEffort: route.reasoningEffort }),
        };
    let started;
    try {
        started = await subagents.startActivation({
            provider: "spawn",
            label: `role ${role}${route === null ? "" : ` · ${formatRoute(route)}`}`,
            name: childName,
            parent,
            signal,
            delivery: "caller",
            ...(cwd === undefined ? {} : { cwd }),
            prompt: [{ type: "text", text: prompt }],
            ...(agentOptions === undefined ? {} : { agentOptions }),
            ...(provider.capabilities !== undefined &&
                provider.capabilities.depthLimit &&
                Number.isInteger(config.childMaxDepth)
                ? { maxDepth: config.childMaxDepth }
                : {}),
        });
    }
    catch (error) {
        throw new Error(`could not start the ${role} role: ${messageOf(error)}`);
    }
    onUpdate?.({
        child: { id: started.childId, name: started.name },
        progress: `${ROLE_LABELS[role]} started · ${formatRoute(route)}`,
    });
    const childLifetime = new AbortController();
    onChild?.({ id: started.childId, signal: childLifetime.signal });
    const unsubscribeEnd = typeof ctx.on === "function"
        ? ctx.on("subagent/end", (info) => {
            if (info.id === started.childId)
                childLifetime.abort();
        })
        : undefined;
    const unsubscribeEvents = typeof ctx.on === "function"
        ? ctx.on("session/event", (session, event) => {
            if (session.id !== started.childId)
                return;
            if (event.type === "tool/call")
                onUpdate?.({ progress: `Tool: ${oneLine(event.data?.name, 100)}` });
            if (event.type === "assistant/message") {
                const text = textOf(event.data?.message?.content);
                if (text)
                    onUpdate?.({ progress: clip(text, 1800) });
            }
        })
        : undefined;
    let result;
    let onAbort = () => { };
    try {
        const aborted = new Promise((_, reject) => {
            onAbort = () => reject(new Error("role team was cancelled"));
            if (signal?.aborted)
                onAbort();
            else
                signal?.addEventListener("abort", onAbort, { once: true });
        });
        result = await Promise.race([started.result, aborted]);
    }
    catch (error) {
        throw new Error(`the ${role} role failed: ${messageOf(error)}`);
    }
    finally {
        childLifetime.abort();
        onChild?.(undefined);
        signal?.removeEventListener("abort", onAbort);
        unsubscribeEvents?.();
        unsubscribeEnd?.();
        try {
            await started.dispose();
        }
        catch {
            // Disposal failure must not replace a captured child result.
        }
    }
    if (result.stopReason === "aborted" ||
        (signal !== undefined && signal.aborted)) {
        throw new Error("role team was cancelled");
    }
    return {
        role,
        route,
        childName: started.name,
        status: result.stopReason,
        text: textOf(result.output),
        diagnostic: typeof result.diagnostic === "string" ? result.diagnostic : undefined,
        durationMs: Date.now() - startedAt,
    };
}
