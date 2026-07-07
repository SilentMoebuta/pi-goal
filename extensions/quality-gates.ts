// 深修 C: 机器可验证质量门 — reviewer 检查清单的机器侧。
// 借鉴 CrewAI guardrail 模式:这些函数作为 reviewer 的检查清单输入,
// reviewer 综合判断(不单靠正则)。不可机器验证项(判断可信度/循环论证)
// 由 reviewer LLM 判断,这里只提供可正则化的辅助。
// Design: docs/superpowers/specs/2026-07-02-non-coding-goal-design.md §四.3
// 注: checkSpawnCoverage 需 hook spawn_role/dag_execute 调用计数,复杂,留 Phase 2。

/** Citation-traceability ratio: fraction of "data point" sentences that carry
 *  a URL or file-path citation. Heuristic (sentence-split), meant as a reviewer
 *  checklist input, not a hard gate. Returns [0, 1].
 *
 *  G4 (CLM 二次 live 测试复盘): the original splitter /[。.；;\n]/ had two bugs that
 *  inflated the denominator and trapped analysis reports below the 0.3 gate:
 *    1. \n split every markdown structural line (headers, |---|, blockquotes) into
 *       a "clause" — most carry no URL, diluting the ratio.
 *    2. bare '.' split URLs: "http://a.com" → ["http://a", "com"], so one cited
 *       sentence became 2 clauses (1 cited) → ratio ~0.33 for fully-cited text.
 *  Fix: split only on Chinese sentence enders 。；; and a period ONLY when followed
 *  by whitespace or end-of-string (\s|$), so URLs with dots stay one clause.
 *  Measured on the real CLM report: 0.21 (old) → 0.655 (fixed), robustly >0.3. */
export function checkCitationTraceability(text: string): number {
	// G5 (pi-goal live 复盘): markdown structural lines (fenced code blocks, YAML
	// frontmatter, table separator rows |---|---|, pure-URL index appendix lines)
	// inflated the denominator and created a perverse incentive — stacking more URLs
	// in an appendix *lowered* the score (each URL line = 1 cited clause, but also
	// 1 denominator unit, while 100 stacked URLs with no 。 between them collapse into
	// 1 clause, so the ratio drops). Real reviewer report measured 0.25 with 105 source
	// URLs appended — strictly worse than 0.27 with 45.
	// G6 (同 live 复盘续): full markdown table rows (| cell | cell |) get shredded by 。/.
	// splitting into many tiny cell-fragments, none carrying a URL — these are structured
	// data presentations whose claims are re-stated in body prose, not argument clauses.
	// Strip whole table rows too, with a floor guard: if stripping leaves <10 clauses,
	// the report is table-only and tables ARE its argument — skip stripping.
	const stripTableRows = (t: string) => t.replace(/^\|.*\|\s*$/gm, "");
	let strippedBase = text
		.replace(/^```[^\n]*\n[\s\S]*?\n```\s*$/gm, "")        // fenced code blocks
		.replace(/^---\n[\s\S]*?\n---\s*\n/gm, "")           // YAML frontmatter
		.replace(/^#{1,6}\s+.*$/gm, "")                      // pure heading lines
		.replace(/^\s*[-*]?\s*(https?:\/\/\S+(\s+|$))+$/gm, ""); // pure-URL index lines
	const withoutTables = stripTableRows(strippedBase);
	// Floor guard: only strip tables if enough prose remains; otherwise keep tables
	// (a table-only report's rows ARE its argument clauses, shred-dilution notwithstanding).
	const stripped = withoutTables.split(/[。；;]|\.(?:\s|$)/).map((s) => s.trim()).filter((s) => s.length > 0).length >= 10
		? withoutTables
		: strippedBase;
	// Split on Chinese/English sentence enders. Period only counts as a sentence end
	// when followed by whitespace or end-of-string, so URLs (http://a.b.c) stay intact.
	// Non-capturing group: a capturing group would inject the separator into the result
	// array (and undefined when $ matches), creating phantom clauses.
	const clauses = stripped.split(/[。；;]|\.(?:\s|$)/).map((s) => s.trim()).filter((s) => s.length > 0);
	if (clauses.length === 0) return 0;
	// URL (http/https) or file-path-like (word/word.ext with slash, or .md/.pdf/.json suffix),
	// or academic citation IDs (arxiv:2103.06268 / doi:10.xxx) which are equally traceable.
	// G5: a quoted clause (Chinese/English quote, markdown blockquote) or a long English-majority
	// clause is itself a fetched original source (paper abstract, vendor doc excerpt) — it IS
	// a citation, so counts as traceable. This prevents analysis reports dense with quoted
	// evidence from scoring low despite every claim being sourced.
	const hasCitation = (s: string) => {
		const t = s.trim();
		return /https?:\/\/\S+/i.test(s) || /\b[\w-]+\/[\w/-]+\.(md|pdf|json|txt|ts|py)\b/i.test(s) || /\bdocs\/\S+/i.test(s) || /\barxiv:\d+\.\d+/i.test(s) || /\bdoi:\s*10\./i.test(s) || /^["””>]/.test(t) || (t.length > 40 && (t.match(/[a-zA-Z]/g) || []).length / t.length > 0.5);
	};
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
