import { clip, isPlainObject, LIMITS } from "./config.js";
import type { Issue, Verdict } from "./types.js";

/**
 * Scan text for balanced JSON objects, ignoring braces inside strings.
 * Does not cut off at 12 objects so final verdicts after quoted code/log JSON
 * blocks are still discovered.
 */
export function jsonObjectCandidates(text: string): string[] {
	const candidates = [];
	let start = -1;
	let depth = 0;
	let inString = false;
	let escaped = false;
	for (let index = 0; index < text.length; index += 1) {
		const char = text[index];
		if (inString) {
			if (escaped) escaped = false;
			else if (char === "\\") escaped = true;
			else if (char === '"') inString = false;
			continue;
		}
		if (char === '"') {
			inString = true;
			continue;
		}
		if (char === "{") {
			if (depth === 0) start = index;
			depth += 1;
			continue;
		}
		if (char === "}" && depth > 0) {
			depth -= 1;
			if (depth === 0 && start >= 0) {
				candidates.push(text.slice(start, index + 1));
				start = -1;
				if (candidates.length >= 256) break;
			}
		}
	}
	return candidates;
}

/**
 * Normalize severity synonyms into canonical `blocker | major | minor`.
 * Unknown severities default to `major` so non-minor issues always block.
 */
export function normalizeSeverity(raw: unknown): string {
	if (typeof raw !== "string") return "major";
	const value = raw.trim().toLowerCase();
	if (
		value === "blocker" ||
		value === "critical" ||
		value === "fatal" ||
		value === "severe" ||
		value === "error" ||
		value === "p0"
	) {
		return "blocker";
	}
	if (
		value === "minor" ||
		value === "low" ||
		value === "nit" ||
		value === "nitpick" ||
		value === "info" ||
		value === "suggestion" ||
		value === "trivial" ||
		value === "style" ||
		value === "p2" ||
		value === "p3"
	) {
		return "minor";
	}
	return "major";
}

/** Normalise one issue value from a verdict. */
function normalizeIssue(issue: unknown, fallback: string): Issue {
	if (typeof issue === "string" && issue.trim() !== "") {
		return { severity: "major", detail: clip(issue.trim(), LIMITS.issueChars) };
	}
	if (isPlainObject(issue)) {
		const severity = normalizeSeverity(issue.severity);
		const detail =
			issue.detail ?? issue.message ?? issue.description ?? issue.title;
		if (typeof detail === "string" && detail.trim() !== "") {
			return { severity, detail: clip(detail.trim(), LIMITS.issueChars) };
		}
	}
	return { severity: "major", detail: clip(fallback, LIMITS.issueChars) };
}

/**
 * Parse an ADVISOR/REVIEWER verdict.
 *
 * The preferred form is strict JSON (scanning from the last candidate backwards
 * so prose examples earlier in the message do not shadow the final verdict).
 * A missing or malformed object falls back to a conservative text heuristic.
 */
export function parseVerdict(text: string): Verdict {
	const source = String(text ?? "");
	const candidates = jsonObjectCandidates(source);
	for (let idx = candidates.length - 1; idx >= 0; idx -= 1) {
		const candidate = candidates[idx]!;
		try {
			const value = JSON.parse(candidate);
			if (!isPlainObject(value) || typeof value.approved !== "boolean")
				continue;
			const rawIssues = Array.isArray(value.issues)
				? value.issues
				: typeof value.issues === "string" && value.issues.trim() !== ""
					? [value.issues]
					: [];
			const issues = rawIssues.map((issue) =>
				normalizeIssue(issue, "unspecified issue"),
			);
			// Any non-minor issue (blocker or major) keeps the gate closed.
			const blocking = issues.some((issue) => issue.severity !== "minor");
			return {
				approved: value.approved && !blocking,
				summary:
					typeof value.summary === "string"
						? clip(value.summary, LIMITS.verdictChars)
						: "",
				issues,
				parsed: true,
			};
		} catch {
			// Not JSON, or a non-verdict object: continue scanning.
		}
	}
	const sanitizedLower = source
		.toLowerCase()
		.replace(
			/\b(?:no|0|zero|without(?:\s+any)?)\s+blockers?(?:\s+(?:issues?|problems?|bugs?|found))?\b/g,
			" ",
		);
	const rejected =
		/\bnot approved\b|\bchanges required\b|\brejected\b|\bblocker\b/.test(
			sanitizedLower,
		);
	// Only a declared approval counts in the fallback; a stray "approved" inside
	// a sentence such as "it would be approved after X" must not release the gate.
	const declared =
		/^\s*(?:final\s+)?(?:verdict\s*:\s*)?approved\b/im.test(source) ||
		/\bapproved\s*:\s*true\b/i.test(source);
	const approved = declared && !rejected;
	return {
		approved,
		summary: clip(source.trim(), LIMITS.verdictChars),
		issues: approved
			? []
			: [
					{
						severity: "major",
						detail: clip(
							source.trim() === ""
								? "the role returned no verdict"
								: source.trim(),
							LIMITS.issueChars * 2,
						),
					},
				],
		parsed: false,
	};
}

/** Render issues as numbered worker feedback. */
export function feedbackLines(issues: Issue[]): string[] {
	return issues.map((issue) => `[${issue.severity}] ${issue.detail}`);
}

/**
 * Detect whether a WORKER report explicitly declared `STATUS: blocked`.
 */
export function parseWorkerStatus(text: string): {
	blocked: boolean;
	detail: string;
} {
	const source = String(text ?? "");
	const match = /^\s*(?:\*{0,2})STATUS(?:\*{0,2})\s*:\s*blocked\b(.*)$/im.exec(
		source,
	);
	if (!match) return { blocked: false, detail: "" };
	const inlineReason = (match[1] ?? "").replace(/^[\s:—–-]+/, "").trim();
	const notesMatch =
		/(?:^|\n)\s*(?:\*{0,2})NOTES(?:\*{0,2})\s*:\s*([\s\S]*?)(?=\n\s*(?:\*{0,2})(?:CHANGES|EVIDENCE|STATUS|NOTES)(?:\*{0,2})\s*:|$)/i.exec(
			source,
		);
	const notes = notesMatch?.[1]?.trim() ?? "";
	const detail =
		notes ||
		inlineReason ||
		clip(source.trim(), LIMITS.issueChars) ||
		"WORKER reported STATUS: blocked without details";
	return {
		blocked: true,
		detail: clip(detail, LIMITS.issueChars),
	};
}
