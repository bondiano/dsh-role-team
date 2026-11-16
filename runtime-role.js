/** Executes external role routes without changing the existing native LLM path. */
export async function validateRuntimeRoute(ctx, route) {
  const service = ctx.get('agentRuntime')
  if (!service) throw new Error(`Runtime unavailable: ${route.runtime}`)
  const listing = await service.list()
  if (!listing.runtimes.some(runtime => runtime.id === route.runtime)) throw new Error(`Runtime unavailable: ${route.runtime}`)
}

export async function runRuntimeRole(ctx, { route, role, prompt, parent, signal, cwd }) {
  const service = ctx.get('agentRuntime')
  if (!service) throw new Error(`Runtime unavailable: ${route.runtime}`)
  const directory = cwd ?? await ctx.get('workingDirectory')?.ensure(parent, signal)
  if (!directory) throw new Error('Role runtime requires a working directory')
  const startedAt = Date.now()
  const session = await service.create({ runtime: route.runtime, cwd: directory, model: route.model,
    provider: route.provider, reasoningEffort: route.reasoningEffort }, { parent, signal })
  const isolatedPrompt = `Execution workspace: ${session.cwd}. Work exclusively in this isolated copy; do not edit the source workspace ${directory}.\n\n${prompt.replace(/^Workspace: .*$/m, `Workspace: ${session.cwd}`)}`
  let text = ''
  let terminalText = ''
  let status = 'completed'
  const artifacts = []
  try {
    for await (const event of service.send(session.id, { text: isolatedPrompt }, { parent, signal })) {
      if (event.type === 'text') text = `${text}${event.text ?? ''}`.slice(-14000)
      if (event.type === 'completed') {
        status = event.status ?? 'completed'
        terminalText = typeof event.text === 'string' ? event.text : ''
      }
      if (event.type === 'artifact' && event.path) artifacts.push(event.path)
      if (event.type === 'settled') status = event.status
    }
  } finally {
    await service.close(session.id)
  }
  if (signal?.aborted || ['cancelled', 'aborted'].includes(status)) throw new Error('role team was cancelled')
  if (!['completed', 'finished'].includes(status)) throw new Error(`External role ${role} failed: ${status}`)
  return { role, route, childName: session.id, status, text: text || terminalText.slice(-14000),
    cwd: session.cwd, runtimeSessionId: session.id, artifacts, durationMs: Date.now() - startedAt,
    diagnostic: `Isolated result: ${session.cwd}${artifacts.length ? `; artifacts: ${artifacts.join(', ')}` : ''}. Changes have not been applied to the source workspace.` }
}
