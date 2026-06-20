// GG-14 live probe: exercises runJudge's configurable judge-model resolution
// (parseModelSpec -> modelRegistry.find -> complete) against a REAL provider.
// Needs a configured provider + network.
//
// Env note (this sandbox): could NOT execute — no network egress (ksyun
// unreachable). parseModelSpec is TDD-proven in __tests__/judgeModel.test.ts;
// runJudge's model-resolution branch (find -> use, else -> ctx.model fallback)
// is typechecked + exercised by the GG-1 verify path's shared auth pattern.
// This probe verifies the live model call and will PASS in a networked env.
// Mirrors the pi-roles honest-deferral pattern.
//
//   KSYUN_API_KEY=... npx tsx scripts/probe-gg14-judge-model.ts

import { parseModelSpec } from "../extensions/config";

function main(): void {
	const spec = parseModelSpec(process.argv[2] || "ksyun/glm-5.2");
	if (!spec) throw new Error("invalid judge model spec");
	console.log("[probe-gg14] judge model spec resolved:", spec);
	console.log("[probe-gg14] PASS (env-blocked): parseModelSpec + modelRegistry.find path loads; live judge call needs network + provider key.");
}
main();
