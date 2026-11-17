/** Shared helpers for reading invoked XState actor `onDone` / `onError` payloads. */

export function actorOutput<T>(event: unknown): T {
	return (event as { output: T }).output;
}

export function actorError(event: unknown): unknown {
	return (event as { error: unknown }).error;
}
