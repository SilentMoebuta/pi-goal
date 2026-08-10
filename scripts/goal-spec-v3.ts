#!/usr/bin/env node
import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

import {
	GoalSpecCompileError,
	compileGoalProjectSpecV3,
	migrateGoalSpecMarkdownV2ToV3,
	parseGoalProjectSpecV3,
} from "../extensions/spec-compiler-v3";

export function runGoalSpecCli(argv: string[]): number {
	const [command, inputPath, outputPath] = argv;
	if (!command || !inputPath || !["lint", "compile", "migrate"].includes(command)) {
		process.stderr.write("Usage: npm run goal-spec -- <lint|compile|migrate> <input> [output]\n");
		return 2;
	}
	try {
		const input = fs.readFileSync(path.resolve(inputPath), "utf8");
		if (command === "lint") {
			const result = parseGoalProjectSpecV3(JSON.parse(input));
			process.stdout.write(JSON.stringify({ ok: result.ok, issues: result.issues }, null, 2) + "\n");
			return result.ok ? 0 : 1;
		}
		if (command === "compile") {
			const result = compileGoalProjectSpecV3(JSON.parse(input));
			writeOutput(outputPath, result.markdown);
			return 0;
		}
		const migrated = migrateGoalSpecMarkdownV2ToV3(input);
		writeOutput(outputPath, JSON.stringify(migrated, null, 2) + "\n");
		return 0;
	} catch (error) {
		const detail = error instanceof GoalSpecCompileError
			? { error: error.message, issues: error.issues }
			: { error: error instanceof Error ? error.message : String(error) };
		process.stderr.write(JSON.stringify(detail, null, 2) + "\n");
		return 1;
	}
}

function writeOutput(outputPath: string | undefined, content: string): void {
	if (!outputPath) {
		process.stdout.write(content.endsWith("\n") ? content : content + "\n");
		return;
	}
	const absolute = path.resolve(outputPath);
	fs.mkdirSync(path.dirname(absolute), { recursive: true });
	const temp = `${absolute}.tmp-${process.pid}`;
	fs.writeFileSync(temp, content.endsWith("\n") ? content : content + "\n", "utf8");
	fs.renameSync(temp, absolute);
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
if (import.meta.url === invokedPath) process.exitCode = runGoalSpecCli(process.argv.slice(2));
