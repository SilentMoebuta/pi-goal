// 深修 C: 机器可验证质量门 — reviewer 检查清单的机器侧。
// 借鉴 CrewAI guardrail 模式:这些函数作为 reviewer 的检查清单输入,
// reviewer 综合判断(不单靠正则)。不可机器验证项(判断可信度/循环论证)
// 由 reviewer LLM 判断,这里只提供可正则化的辅助。
// Design: docs/superpowers/specs/2026-07-02-non-coding-goal-design.md §四.3
// 注: checkSpawnCoverage 需 hook spawn_role/dag_execute 调用计数,复杂,留 Phase 2。

/** Citation-traceability ratio: fraction of "data point" sentences that carry
 *  a URL or file-path citation. Heuristic (sentence-split by 。/./；/;), meant
 *  as a reviewer checklist input, not a hard gate. Returns [0, 1]. */
export function checkCitationTraceability(text: string): number {
	// Split into clauses by common Chinese/English sentence separators.
	const clauses = text.split(/[。.；;\n]/).map((s) => s.trim()).filter((s) => s.length > 0);
	if (clauses.length === 0) return 0;
	// URL (http/https) or file-path-like (word/word.ext with slash, or .md/.pdf/.json suffix)
	const hasCitation = (s: string) =>
		/https?:\/\/\S+/i.test(s) || /\b[\w-]+\/[\w/-]+\.(md|pdf|json|txt|ts|py)\b/i.test(s) || /\bdocs\/\S+/i.test(s);
	const cited = clauses.filter(hasCitation).length;
	return cited / clauses.length;
}

/** Source diversity: count of distinct sources cited. Detects both URL
 *  domains and Chinese-style （来源：X） / (来源:Y) institution tags.
 *  Returns a non-negative integer (count). */
export function checkSourceDiversity(text: string): number {
	const sources = new Set<string>();
	// URL domains
	const urlRe = /https?:\/\/([\w.-]+)/gi;
	let m: RegExpExecArray | null;
	while ((m = urlRe.exec(text)) !== null) {
		sources.add(m[1].toLowerCase());
	}
	// Chinese institution citations: （来源：X） / (来源:Y)
	const instRe = /[（(]\s*来源[:：]\s*([^）)]+)[）)]/g;
	while ((m = instRe.exec(text)) !== null) {
		sources.add(m[1].trim().toLowerCase());
	}
	return sources.size;
}

/** Confidence-annotation presence: true when the text carries an explicit
 *  置信度 annotation (high/中/low/猜测 or 高/中/低/猜测). Reviewer checklist
 *  input — a research report without any confidence annotation is a red flag. */
export function checkConfidenceAnnotation(text: string): boolean {
	return /置信度\s*[:：]\s*(高|中|低|猜测|high|medium|low|guess)/i.test(text);
}
