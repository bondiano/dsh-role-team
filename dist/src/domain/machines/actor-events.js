/** Shared helpers for reading invoked XState actor `onDone` / `onError` payloads. */
export function actorOutput(event) {
    return event.output;
}
export function actorError(event) {
    return event.error;
}
