import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { complete } from "@earendil-works/pi-ai/compat";
import { parseModelSpec, DEFAULT_GOAL_CONFIG, type GoalConfig } from "./config";
import { validateCompletionPolicy } from "./completion-policy-v2";
import { V2_JUDGE_SYSTEM_PROMPT, buildV2JudgePrompt, parseV2JudgeResponse } from "./completion-runtime-v2";
import { buildBoundedEvidencePacket, completionDecisionToEvaluation } from "./goal-integration-v2";
import { runVerifyCommand, type VerifyResult } from "./verify-command";
import { extractTextContent, GOAL_JUDGE_TYPE } from "./util";
import type { CompletionEvaluation, GoalStateV2 } from "./state";

export interface JudgeVerdict {
	done: boolean;
	reason: string;
	parseFailed: boolean;
}

export interface V2JudgeRun {
	evaluation: CompletionEvaluation;
	parseFailed: boolean;
}

const JUDGE_SYSTEM_PROMPT = "You are a strict completion judge for an autonomous coding agent.\n" +
	"The agent has been working toward a goal. You receive:\n" +
	"1. The goal objective and its acceptance criteria\n" +
	"2. The agent's most recent response (including any tool calls made and their results)\n\n" +
	"Decide whether the goal is FULLY ACHIEVED based on the evidence in the agent's response.\n\n" +
	"A goal is DONE only when:\n" +
	"- Every explicit criterion has concrete, specific evidence in the response\n" +
	"- The agent has verified deliverables against real artifacts (files, test output, build status)\n" +
	"- No criterion lacks evidence\n\n" +
	"A goal is NOT done when:\n" +
	"- Any criterion is missing, incomplete, or unverified\n" +
	"- Evidence is vague (\"all tests pass\" without showing which tests)\n" +
	"- Criteria were not individually checked against real output\n\n" +
	"Reply ONLY with a single JSON object on one line, no markdown fences:\n" +
	'{"done": true, "reason": "brief rationale"}\n' +
	"or\n" +
	'{"done": false, "reason": "what\'s missing"}';

// M2: module-level — runJudge sets it; sendContinuation (closure) reads+clears it.
export async function runJudge(
	goal: GoalStateV2,
	responseText: string,
	ctx: ExtensionContext,
	pi: ExtensionAPI,
	config: GoalConfig = DEFAULT_GOAL_CONFIG,
	precomputedVerification?: VerifyResult,
	completeFn: typeof complete = complete,
	/** Called when the deterministic verify command fails, so the caller can
	 *  feed the reason into the next continuation. */
	onVerifyFail?: (note: string) => void,
): Promise<JudgeVerdict> {
	// GG-1: deterministic command-based verification (opt-in via .pi/goal.json
	// verifyCommand, trusted projects only — loadGoalConfig only populates the
	// field when trusted, so its presence here is proof of trust). Run BEFORE
	// the LLM judge: a non-zero exit short-circuits done:false with the
	// truncated output as the reason. When ok, fall through to the LLM judge
	// (with a note that the verify command passed). When verifyCommand is
	// unset, behavior is UNCHANGED — LLM-judge-only (backward compatible).
	if (config.verifyCommand) {
		const verify = precomputedVerification
			?? await runVerifyCommand(config.verifyCommand, config.verifyTimeoutMs ?? 120_000);
		if (!verify.ok) {
			const detail = (verify.stderr || verify.stdout).trim();
			const exitPart = verify.exitCode === null
				? "no exit code (killed or failed to spawn)"
				: "exit " + verify.exitCode;
			const reason = "verify command failed (" + exitPart + "): " + (detail || "(no output)");
			const verdict: JudgeVerdict = { done: false, reason, parseFailed: false };
			// M2/L2: feed the failure back to the agent (next continuation prepends
			// verifyFailNote) + notify the user proactively.
			onVerifyFail?.(reason);
			ctx.ui?.notify?.("⚠ Verify command failed (" + exitPart + "). See /goal status.", "warning");
			pi.sendMessage(
				{ customType: GOAL_JUDGE_TYPE, content: "Judge: VERIFY-FAILED — " + reason, display: false, details: { verdict, durationMs: 0, modelId: null, verify } },
				{ triggerTurn: false },
			);
			return verdict;
		}
		// verify.ok: fall through to the LLM judge, noting external verification passed.
	}

	// GG-14: resolve a configurable judge model ("provider/model-id" from
	// .pi/goal.json, trusted projects). Falls back to ctx.model when unset or
	// unresolvable so behavior is backward-compatible.
	let model = ctx.model;
	if (config.judgeModel) {
		const spec = parseModelSpec(config.judgeModel);
		const found = spec ? ctx.modelRegistry?.find?.(spec.provider, spec.modelId) : undefined;
		if (found) model = found;
		else console.warn("[pi-goal] judgeModel \"" + config.judgeModel + "\" not found in registry; falling back to ctx.model.");
	}
	if (!model) {
		return { done: false, reason: "no model available for judge", parseFailed: false };
	}

	const criteriaBlock = goal.criteria.length > 0
		? "\nCriteria:\n" + goal.criteria.map((c) => `  [${c.evidence.length > 0 ? "\u2713" : " "}] ${c.description}`).join("\n")
		: "";

	const verifyNote = config.verifyCommand
		? "\n\nNote: a deterministic verify command was configured and PASSED (exit 0). Treat this as strong (but not sole) completion evidence — still check every criterion."
		: "";
	const judgePrompt = "Goal: " + goal.objective + criteriaBlock + "\n\nAgent's most recent response:\n" + responseText.slice(0, 8_000) + "\n\nIs the goal fully achieved? Check each criterion against concrete evidence in the response." + verifyNote;

	const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
	if (!auth.ok) {
		return { done: false, reason: `judge auth failed: ${auth.error}`, parseFailed: false };
	}

	const startMs = Date.now();
	try {
		const result = await completeFn(
			model,
			{
				systemPrompt: JUDGE_SYSTEM_PROMPT,
				messages: [{ role: "user", content: [{ type: "text", text: judgePrompt }], timestamp: Date.now() }],
			},
			{
				apiKey: auth.apiKey,
				headers: auth.headers,
				temperature: 0,
				maxTokens: 256,
			},
		);
		const rawResponse = extractTextContent(result);
		const durationMs = Date.now() - startMs;

		let verdict: JudgeVerdict;
		try {
			const parsed = JSON.parse(rawResponse.trim());
			verdict = { done: parsed.done === true, reason: typeof parsed.reason === "string" ? parsed.reason : rawResponse, parseFailed: false };
		} catch {
			const jsonMatch = rawResponse.match(/\{[\s\S]*\}/);
			if (jsonMatch) {
				try {
					const parsed = JSON.parse(jsonMatch[0]);
					verdict = { done: parsed.done === true, reason: typeof parsed.reason === "string" ? parsed.reason : "unparseable", parseFailed: false };
				} catch {
					verdict = { done: false, reason: "judge response not JSON", parseFailed: true };
				}
			} else {
				verdict = { done: false, reason: "judge response not JSON", parseFailed: true };
			}
		}

		pi.sendMessage(
			{
				customType: GOAL_JUDGE_TYPE,
				content: `Judge: ${verdict.done ? "DONE" : "CONTINUE"} — ${verdict.reason}`,
				display: false,
				details: { verdict, durationMs, modelId: model.id, usage: result.usage },
			},
			{ triggerTurn: false },
		);

		return verdict;
	} catch (err) {
		return { done: false, reason: `judge error: ${err instanceof Error ? err.message : String(err)}`, parseFailed: false };
	}
}

export async function runV2CompletionJudge(
	goal: GoalStateV2,
	responseText: string,
	ctx: ExtensionContext,
	pi: ExtensionAPI,
	config: GoalConfig,
	verification?: VerifyResult,
	completeFn: typeof complete = complete,
): Promise<V2JudgeRun> {
	const packet = buildBoundedEvidencePacket({
		goal,
		latestResponse: responseText,
		...(config.verifyCommand && verification
			? { deterministicVerification: { command: config.verifyCommand, result: verification } }
			: {}),
	});
	const constraintCriteria = packet.goal.constraints.map((description, index) => ({
		id: "$constraint:" + index,
		description,
		level: "blocking" as const,
		evidenceRefs: packet.evidenceLedger.map((item) => item.id),
	}));
	const judgePacket = { ...packet, criteria: [...packet.criteria, ...constraintCriteria] };
	let model = ctx.model;
	const evaluatorSpec = config.evaluatorModel ?? config.judgeModel;
	if (evaluatorSpec) {
		const spec = parseModelSpec(evaluatorSpec);
		const found = spec ? ctx.modelRegistry?.find?.(spec.provider, spec.modelId) : undefined;
		if (found) model = found;
		else console.warn("[pi-goal] evaluatorModel \"" + evaluatorSpec + "\" not found; falling back to the session model.");
	}

	let rawVerdict: unknown = "No evaluator model is available.";
	let modelId: string | undefined;
	let durationMs = 0;
	if (model) {
		modelId = evaluatorSpec ?? model.id;
		const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
		if (auth.ok) {
			const startedAt = Date.now();
			try {
				const result = await completeFn(model, {
					systemPrompt: V2_JUDGE_SYSTEM_PROMPT,
					messages: [{ role: "user", content: [{ type: "text", text: buildV2JudgePrompt(judgePacket) }], timestamp: Date.now() }],
				}, {
					apiKey: auth.apiKey,
					headers: auth.headers,
					temperature: 0,
					maxTokens: 4_096,
				});
				durationMs = Date.now() - startedAt;
				rawVerdict = parseV2JudgeResponse(extractTextContent(result));
			} catch (error) {
				durationMs = Date.now() - startedAt;
				rawVerdict = "Evaluator error: " + (error instanceof Error ? error.message : String(error));
			}
		} else {
			rawVerdict = "Evaluator authentication failed: " + auth.error;
		}
	}

	const decision = validateCompletionPolicy({
		criteria: [
			...goal.criteria,
			...goal.constraints.map((description, index) => ({
				id: "$constraint:" + index,
				description,
				level: "blocking" as const,
				evidenceRefs: goal.evidenceLedger.map((item) => item.id),
			})),
		],
		claims: goal.claims,
		evidenceLedger: goal.evidenceLedger,
		judgeVerdict: rawVerdict,
		assurance: goal.assurance,
		deterministicVerification: config.verifyCommand && verification
			? { ok: verification.ok, exitCode: verification.exitCode }
			: null,
	});
	const evaluation = completionDecisionToEvaluation(decision, {
		evaluatedAt: Date.now(),
		evaluator: { kind: "judge", ...(modelId ? { model: modelId } : {}) },
	});
	pi.sendMessage({
		customType: GOAL_JUDGE_TYPE,
		content: "Goal V2 evaluator: " + evaluation.decision.toUpperCase() +
			(evaluation.findings.length > 0 ? " - " + evaluation.findings.map((item) => item.reason).join("; ") : ""),
		display: false,
		details: { policy: "v2", evaluation, durationMs, packetTruncation: packet.truncation },
	}, { triggerTurn: false });
	return { evaluation, parseFailed: decision.judgeContractErrors.length > 0 };
}

// ═══════════════════════════════════════════════════════════════════════
// Prompt Generation
// ═══════════════════════════════════════════════════════════════════════
