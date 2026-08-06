/**
 * 共享小工具与事件类型常量。从 index.ts 拆出（审计 P2：大文件拆分），
 * 供 judge / prompt-blocks / draft-review-ui / index 共用，避免循环依赖。
 */
import type { AssistantMessage } from "@earendil-works/pi-ai";

export const GOAL_STORAGE_TYPE = "pi-goal";
export const GOAL_EVENT_TYPE = "pi-goal:event";
export const GOAL_CONTINUATION_TYPE = "pi-goal:continuation";
export const GOAL_JUDGE_TYPE = "pi-goal:judge";

export function formatTokens(value: number): string {
	if (value >= 1_000_000) return (value / 1_000_000).toFixed(1) + "M";
	if (value >= 1_000) return (value / 1_000).toFixed(1) + "k";
	return String(value);
}

export function formatDuration(ms: number): string {
	const seconds = Math.floor(ms / 1000);
	if (seconds < 60) return seconds + "s";
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return minutes + "m " + (seconds % 60) + "s";
	const hours = Math.floor(minutes / 60);
	return hours + "h " + (minutes % 60) + "m";
}

export function escapeXml(s: string): string {
	return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function extractOutputTokens(event: { message?: { role?: string; usage?: { output?: number } } }): number {
	const usage = event.message?.usage;
	if (typeof usage?.output === "number" && Number.isFinite(usage.output) && usage.output >= 0) return usage.output;
	return 0;
}

export function extractTextContent(msg: AssistantMessage): string {
	const parts = Array.isArray(msg.content) ? msg.content : [];
	return parts
		.filter((part): part is { type: "text"; text: string } => typeof part === "object" && part !== null && (part as { type?: string }).type === "text")
		.map((part) => part.text)
		.join("\n");
}

export function isAssistantMessage(m: { role?: string }): m is AssistantMessage {
	return m?.role === "assistant";
}
