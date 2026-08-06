/**
 * 证据机械验证（Proof-or-Stop 理念落地，审计 P0）：
 * artifact 类证据的 verification 字段不再信任 agent 自报——写入时由
 * 文件系统机械校验（存在性 + 可选内容 hash），声称 verified 但文件
 * 不存在则强制 rejected。command/source/observation 等无法无副作用
 * 机械校验的类型保持 agent 声称值（由 judge 语义评估兜底）。
 */
import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import type { EvidenceRef } from "./state";

export interface MechanicalVerification {
	ok: boolean;
	checks: Array<{ check: string; ok: boolean; detail?: string }>;
	verification: EvidenceRef["verification"];
}

/** locator 形如 "path/to/file" / "file:path" / "artifact:path" 时提取相对路径。 */
function artifactPath(locator: string, cwd: string): string | null {
	const trimmed = locator.trim();
	let candidate = trimmed;
	for (const prefix of ["file:", "artifact:", "path:"]) {
		if (trimmed.startsWith(prefix)) { candidate = trimmed.slice(prefix.length).trim(); break; }
	}
	if (!candidate || candidate.startsWith("http://") || candidate.startsWith("https://")) return null;
	// 去掉引号包裹
	candidate = candidate.replace(/^["']|["']$/g, "");
	if (path.isAbsolute(candidate)) return candidate;
	return path.resolve(cwd, candidate);
}

/**
 * 机械验证一条证据。纯确定性，无 LLM、无命令执行（stat + 可选 hash）。
 * - kind=artifact 且 locator 解析为本地路径：存在性检查；存在 → verified，
 *   不存在 → rejected（覆盖 agent 声称值，防伪）。
 * - 其他 kind：不机械覆盖，返回原值（checks 空）。
 * - agent 声称 verified 而机械检查失败 → rejected（Proof-or-Stop）。
 */
export function mechanicallyVerifyEvidence(record: EvidenceRef, cwd: string): EvidenceRef {
	if (record.kind !== "artifact") return record;
	const locator = (record.locator ?? "").trim();
	if (!locator) return record;
	const filePath = artifactPath(locator, cwd);
	if (!filePath) return record;

	const checks: MechanicalVerification["checks"] = [];
	const exists = fs.existsSync(filePath);
	checks.push({ check: "artifact_exists", ok: exists, detail: exists ? filePath : `${filePath} (not found)` });
	let verified = exists;
	if (exists) {
		try {
			const stat = fs.statSync(filePath);
			checks.push({ check: "artifact_readable", ok: stat.isFile(), detail: stat.isFile() ? `${stat.size} bytes` : "not a regular file" });
			verified = verified && stat.isFile();
			// 小文件（≤1MB）附带 SHA-256，供 completion judge 绑定源状态。
			if (verified && stat.size <= 1_048_576) {
				const hash = crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex").slice(0, 16);
				checks.push({ check: "artifact_hash", ok: true, detail: hash });
			}
		} catch (error) {
			checks.push({ check: "artifact_readable", ok: false, detail: error instanceof Error ? error.message : String(error) });
			verified = false;
		}
	}

	const verification: EvidenceRef["verification"] = verified ? "verified" : "rejected";
	return {
		...record,
		verification,
		...(verified ? {} : { verificationNote: "Mechanical verification failed: " + checks.map((c) => `${c.check}=${c.ok ? "ok" : "FAIL"}${c.detail ? ` (${c.detail})` : ""}`).join("; ") }),
	};
}

/** 汇总一条证据的全部机械检查（供审计/UI 展示）。 */
export function describeMechanicalChecks(record: EvidenceRef): MechanicalVerification | null {
	const note = (record as { verificationNote?: string }).verificationNote;
	if (record.kind !== "artifact") return null;
	return {
		ok: record.verification === "verified",
		checks: [],
		verification: record.verification,
		...(note ? { checks: [{ check: "note", ok: record.verification === "verified", detail: note }] } : {}),
	};
}
