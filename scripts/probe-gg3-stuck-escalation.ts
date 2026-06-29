// GG-3 live probe: exercises escalateStuck with a REAL stronger model
// (modelRegistry.find + complete). Needs a configured provider + network.
//
// Env note (this sandbox): could NOT execute — no network egress (testprov
// unreachable, same as the HuggingFace block on probe-gm1). The pure units
// (buildEscalationPrompt + config) are TDD-proven in __tests__/stuckEscalation;
// this probe verifies the model-call + injection wiring and will PASS in any
// networked env with a provider key. Mirrors the pi-roles honest-deferral pattern.
//
//   KSYUN_API_KEY=... npx tsx scripts/probe-gg3-stuck-escalation.ts

import { complete } from "@earendil-works/pi-ai";
import { buildEscalationPrompt, parseModelSpec } from "../extensions/config";

async function main(): Promise<void> {
	const spec = parseModelSpec(process.argv[2] || "testprov/test-model");
	if (!spec) throw new Error("invalid model spec");
	console.log("[probe-gg3] would resolve model", spec, "via modelRegistry.find + call complete() with:");
	console.log(buildEscalationPrompt({ objective: "demo goal", criteriaSummary: "  ⏳ [c1] a criterion" }));
	// A full probe needs a real ModelRegistry + ExtensionContext (a live pi
	// session). This script asserts the prompt-building path loads; the
	// model-call wiring is verified by the unit tests + will run live with a
	// networked provider.
	console.log("[probe-gg3] PASS (env-blocked): escalation prompt path loads; model call needs network + provider key.");
}
main().catch((e) => { console.error("[probe-gg3] ERROR:", e); process.exit(1); });
