#!/usr/bin/env node

import {
	copyFileSync,
	existsSync,
	lstatSync,
	readFileSync,
	readdirSync,
	mkdirSync,
	mkdtempSync,
	renameSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
const SCRIPT_PATH = fileURLToPath(import.meta.url);
const SOURCE_REPO = resolve(dirname(SCRIPT_PATH), "..");
const RELEASE_PACKAGES = [
	"packages/chord",
	"packages/telemetry",
	"packages/ai",
	"packages/durable",
	"packages/tui",
	"packages/agent",
	"packages/protocol",
	"packages/client",
	"packages/session-backends/sqlite-node",
	"packages/server",
	"packages/coding-agent",
];
const HOME = process.env.PI_GPT6_HOME?.trim() || join(homedir(), ".local", "share", "pi-gpt-6");
const BIN_DIR = process.env.PI_GPT6_BIN_DIR?.trim() || join(homedir(), ".local", "bin");
const REPO_FILE = join(HOME, "source-repository");
const LAUNCHER_FILE = join(HOME, "launcher.mjs");
const CURRENT_LINK = join(HOME, "current");
const PACKAGE_NAME = "@earendil-works/pi-coding-agent";
const TIMEOUT_MS = 1_500_000;

function run(command, args, options = {}) {
	console.log(`$ ${[command, ...args].join(" ")}`);
	const { capture, ...spawnOptions } = options;
	const result = spawnSync(command, args, {
		cwd: spawnOptions.cwd,
		encoding: "utf8",
		stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
		timeout: TIMEOUT_MS,
		...spawnOptions,
	});
	if (result.error || result.status !== 0) {
		const detail = result.error?.message || result.stderr?.trim() || `exit code ${result.status ?? "unknown"}`;
		throw new Error(`Command failed: ${command} ${args.join(" ")} (${detail})`);
	}
	return result.stdout ?? "";
}

function getRepository() {
	if (process.env.PI_GPT6_REPO?.trim()) return resolve(process.env.PI_GPT6_REPO);
	try {
		return resolve(readFileSync(REPO_FILE, "utf8").trim());
	} catch {
		throw new Error("Fork source path is missing. Run scripts/install-pi-gpt-6.sh from the fork checkout.");
	}
}

function currentCli() {
	const cli = join(CURRENT_LINK, "node_modules", PACKAGE_NAME, "dist", "bundle", "cli.js");
	if (!existsSync(cli)) throw new Error("No installed pi-gpt-6 release found. Run scripts/install-pi-gpt-6.sh from the source checkout.");
	return cli;
}

function runCurrent(args, cwd = process.cwd()) {
	const result = spawnSync(process.execPath, [currentCli(), ...args], {
		cwd,
		stdio: "inherit",
	});
	if (result.error) throw result.error;
	process.exitCode = result.status ?? 1;
}

function classifyUpdate(args) {
	if (args[0] !== "update") return undefined;
	const options = args.slice(1);
	if (options.includes("--agent")) return options.length === 1 ? { type: "agent" } : undefined;

	if (options.length === 0) return { type: "self" };
	if (options.includes("--models") || options.includes("--extension") || options.includes("--extensions")) {
		if (options.includes("--extensions") && options.includes("--all")) return undefined;
		if (
			options.includes("--extensions") &&
			(options.includes("--self") || options.some((value) => value === "self" || value === "pi"))
		) {
			return { type: "all" };
		}
		if (options.includes("--extensions") && options.length === 1) return { type: "delegate" };
		if (options.includes("--models") && options.length === 1) return { type: "delegate" };
		if (options[0] === "--extension" && options.length === 2) return { type: "delegate" };
		if (options.includes("--extension") && options.length === 2) return { type: "delegate" };
		return undefined;
	}

	const positional = options.filter((arg) => !arg.startsWith("-"));
	const flags = options.filter((arg) => arg.startsWith("-"));
	if (flags.some((flag) => flag !== "--self" && flag !== "--force" && flag !== "--all")) return undefined;
	if (positional.length > 1 || positional.some((value) => value !== "self" && value !== "pi")) return { type: "delegate" };
	if (options.includes("--all") && (options.includes("--self") || positional.length > 0)) return undefined;
	if (options.includes("--all")) return { type: "all" };
	if (positional.length === 1) return { type: "self" };
	if (options.includes("--self") || options.includes("--force")) return { type: "self" };
	return { type: "delegate" };
}

function getReleaseId(repository) {
	const sha = run("git", ["rev-parse", "--short=12", "HEAD"], { cwd: repository, capture: true }).trim();
	return `${sha}-${new Date().toISOString().replaceAll(/[-:.TZ]/g, "").slice(0, 14)}`;
}

function updateInstalledLauncher(repository) {
	const nextLauncher = join(HOME, `launcher.tmp.${process.pid}`);
	copyFileSync(join(repository, "scripts", "pi-gpt-6.mjs"), nextLauncher);
	renameSync(nextLauncher, LAUNCHER_FILE);
}

function replaceCurrentLink(releaseDir, home = HOME) {
	const currentLink = join(home, "current");
	const nextLink = join(home, `current.tmp.${process.pid}`);
	rmSync(nextLink, { force: true });
	symlinkSync(releaseDir, nextLink, "dir");
	renameSync(nextLink, currentLink);
}

function pruneReleases(home = HOME) {
	const releasesDir = join(home, "releases");
	if (!existsSync(releasesDir)) return [];
	const currentLink = join(home, "current");
	let currentTarget;
	try {
		currentTarget = resolve(dirname(currentLink), readlinkSync(currentLink));
	} catch {
		return [];
	}

	const releaseName = /^[a-f0-9]{12}-\\d{14}$/;
	const releases = readdirSync(releasesDir, { withFileTypes: true })
		.filter((entry) => releaseName.test(entry.name) && entry.isDirectory())
		.map((entry) => ({ name: entry.name, path: join(releasesDir, entry.name) }))
		.sort((left, right) => right.name.slice(13).localeCompare(left.name.slice(13)) || right.name.localeCompare(left.name));
	const current = releases.find((release) => resolve(release.path) === currentTarget);
	const retained = new Set([...(current ? [current] : []), ...releases.filter((release) => release !== current).slice(0, 5)]);
	for (const release of releases) {
		if (!retained.has(release) && !lstatSync(release.path).isSymbolicLink()) rmSync(release.path, { recursive: true, force: true });
	}
	return [...retained].map((release) => release.name);
}

function activateRelease(releaseDir, home = HOME) {
	replaceCurrentLink(releaseDir, home);
	try {
		pruneReleases(home);
	} catch (error) {
		console.warn(`Activated release, but could not prune older releases: ${error.message}`);
	}
}

function stageRelease(repository) {
	if (process.platform === "win32") throw new Error("pi-gpt-6 managed releases currently require a Unix-like system.");
	const before = run("git", ["status", "--porcelain"], { cwd: repository, capture: true });
	if (before.trim()) throw new Error("Source checkout must be clean before build/validation.");

	run("npm", ["run", "build"], { cwd: repository });
	run("npm", ["run", "check"], { cwd: repository });
	run(
		process.execPath,
		[join(repository, "node_modules", "vitest", "vitest.mjs"), "--run", "test/openai-responses-native-controls.test.ts"],
		{ cwd: join(repository, "packages", "ai") },
	);
	const after = run("git", ["status", "--porcelain"], { cwd: repository, capture: true });
	if (after.trim()) throw new Error("Validation modified tracked source files; refusing to activate this build.");

	const releaseId = getReleaseId(repository);
	const releasesDir = join(HOME, "releases");
	const releaseDir = join(releasesDir, releaseId);
	const stageDir = mkdtempSync(join(HOME, ".staging-"));
	const tarballDir = join(stageDir, "tarballs");
	const consumerDir = join(stageDir, "install");
	mkdirSync(tarballDir, { recursive: true });
	try {
		const tarballs = new Map();
		for (const packagePath of RELEASE_PACKAGES) {
			const output = run("npm", ["pack", "--ignore-scripts", "--json", "--pack-destination", tarballDir], {
				cwd: join(repository, packagePath),
				capture: true,
			});
			const parsed = JSON.parse(output);
			const packed = Array.isArray(parsed) ? parsed[0] : Object.values(parsed)[0];
			const manifest = JSON.parse(readFileSync(join(repository, packagePath, "package.json"), "utf8"));
			tarballs.set(manifest.name, join(tarballDir, packed.filename));
		}
		mkdirSync(consumerDir, { recursive: true });
		const overrides = Object.fromEntries([...tarballs].map(([name, path]) => [
			name,
			`file:../tarballs/${path.split(/[\\/]/).pop()}`,
		]));
		writeFileSync(join(consumerDir, "package.json"), `${JSON.stringify({ private: true, dependencies: { [PACKAGE_NAME]: overrides[PACKAGE_NAME] }, overrides }, null, "\t")}\n`);
		run("npm", ["install", "--ignore-scripts", "--omit=dev", "--no-audit", "--no-fund"], { cwd: consumerDir });
		const installedPackage = join(consumerDir, "node_modules", PACKAGE_NAME);
		const version = JSON.parse(readFileSync(join(installedPackage, "package.json"), "utf8")).version;
		const cli = join(installedPackage, "dist", "bundle", "cli.js");
		const versionOutput = run(process.execPath, [cli, "--version"], { cwd: consumerDir, capture: true }).trim();
		if (versionOutput !== version) throw new Error(`Release smoke test returned ${versionOutput}; expected ${version}.`);
		mkdirSync(releasesDir, { recursive: true });
		if (existsSync(releaseDir)) throw new Error(`Release already exists: ${releaseDir}`);
		renameSync(join(consumerDir, "node_modules"), join(stageDir, "node_modules"));
		writeFileSync(join(stageDir, "release.json"), `${JSON.stringify({ id: releaseId, source: run("git", ["rev-parse", "HEAD"], { cwd: repository, capture: true }).trim() }, null, 2)}\n`);
		rmSync(tarballDir, { force: true, recursive: true });
		rmSync(consumerDir, { force: true, recursive: true });
		renameSync(stageDir, releaseDir);
		updateInstalledLauncher(repository);
		activateRelease(releaseDir);
		console.log(`Activated pi-gpt-6 release ${releaseId}`);
		console.log(`Current release and up to five previous releases remain under ${releasesDir}`);
	} catch (error) {
		rmSync(stageDir, { force: true, recursive: true });
		throw error;
	}
}

function git(repository, args, capture = true) {
	return run("git", args, { cwd: repository, capture });
}

function getConflictPrompt(repository) {
	const currentPatch = (() => {
		try {
			return git(repository, ["-c", "color.ui=false", "status", "--short"], true).trim();
		} catch {
			return "(could not read status)";
		}
	})();
	const topPatch = (() => {
		try {
			return git(repository, ["rev-parse", "--show-toplevel"], true).trim() && run("stg", ["top"], { cwd: repository, capture: true }).trim();
		} catch {
			return "(no current StGit patch reported)";
		}
	})();
	const series = (() => {
		try {
			return run("stg", ["series"], { cwd: repository, capture: true }).trim();
		} catch {
			return "(could not read stg series)";
		}
	})();
	const conflicted = (() => {
		try {
			return git(repository, ["diff", "--name-only", "--diff-filter=U"], true).trim() || "(none reported by git diff)";
		} catch {
			return "(could not determine conflicted files)";
		}
	})();
	const upstreamChanges = (() => {
		try {
			return git(repository, ["log", "--oneline", "--max-count=20", "main@{1}..upstream/main"], true).trim() || "(no new upstream commits listed in main's previous reflog range)";
		} catch {
			return "(could not read upstream/main history)";
		}
	})();
	const combinedDiff = (() => {
		try {
			return git(repository, ["diff", "--cc"], true).trim() || "(no combined diff available)";
		} catch {
			return "(could not read combined conflict diff)";
		}
	})();
	return `Resolve the outstanding upstream patch conflict in this repository: ${repository}

Read PATCHES.md first.

This is an upstream-tracking StGit fork. Inspect the current conflicting patch, stg series, git status, upstream changes, and the patch's intent/invariants. Resolve the conflict semantically. Preserve the behavior the patch exists to provide. Prefer upstream's new architecture over mechanically restoring old code.

If upstream now implements the behavior, shrink the patch or remove it if fully obsolete. After resolving: stage changes, run stg refresh, run stg push --all, run relevant targeted tests, then run npm run check. Do not force-push. Do not modify unrelated upstream behavior. Do not activate or install a new release. Report what changed and any tests that failed.

Current StGit patch:
${topPatch}

StGit series:
${series}

Git status:
${currentPatch}

Conflicted files:
${conflicted}

Upstream changes since current HEAD:
${upstreamChanges}

Combined conflict diff:
${combinedDiff}
`;
}

function saveConflictPrompt(repository) {
	const gitDir = git(repository, ["rev-parse", "--git-path", "pi-gpt-6"], true).trim();
	const promptPath = resolve(repository, gitDir, "update-agent-prompt.md");
	mkdirSync(dirname(promptPath), { recursive: true });
	writeFileSync(promptPath, getConflictPrompt(repository));
	return promptPath;
}

function reportUpdateFailure(repository, error) {
	const status = (() => {
		try {
			return git(repository, ["status", "--short"], true).trim();
		} catch {
			return "(status unavailable)";
		}
	})();
	const isConflict = /^(UU|AA|DD|AU|UA|DU|UD) /m.test(status);
	console.error(`pi-gpt-6 update stopped: ${error.message}`);
	if (!isConflict) return;
	const promptPath = saveConflictPrompt(repository);
	const patch = (() => {
		try {
			return run("stg", ["top"], { cwd: repository, capture: true }).trim();
		} catch {
			return "unknown";
		}
	})();
	const files = (() => {
		try {
			return git(repository, ["diff", "--name-only", "--diff-filter=U"], true).trim() || "(see git status)";
		} catch {
			return "(see git status)";
		}
	})();
	console.error("\nYour currently installed pi-gpt-6 is unchanged and still usable.\n");
	console.error(`Conflicting patch:\n${patch}\n\nConflicted files:\n${files}\n\nRepository:\n${repository}`);
	console.error(`\nTo resolve manually:\n  cd ${repository}\n  cat PATCHES.md\n  stg series\n  git status`);
	console.error("\nTo ask pi-gpt-6 to resolve it:\n  pi-gpt-6 update --agent");
	console.error(`\nAgent prompt written to:\n${promptPath}`);
}

function performForkUpdate(repository) {
	try {
		run(join(repository, "scripts", "update-from-upstream.sh"), [], { cwd: repository });
		stageRelease(repository);
	} catch (error) {
		reportUpdateFailure(repository, error);
		process.exitCode = 1;
	}
}

function runAgentRepair(repository) {
	const status = git(repository, ["status", "--short"], true).trim();
	if (!/^(UU|AA|DD|AU|UA|DU|UD) /m.test(status)) {
		console.error("No unresolved Git conflict was found. Run `pi-gpt-6 update` first.");
		process.exitCode = 1;
		return;
	}
	const promptPath = saveConflictPrompt(repository);
	const prompt = readFileSync(promptPath, "utf8");
	console.log(`Running conflict resolver using the installed pi-gpt-6 release. Prompt: ${promptPath}`);
	runCurrent(["--print", "--no-session", prompt], repository);
	if (process.exitCode !== 0) return;
	const finalStatus = git(repository, ["status", "--porcelain"], true).trim();
	if (finalStatus) {
		console.error("Agent finished, but the source checkout is not clean. Inspect the conflict before retrying.");
		process.exitCode = 1;
		return;
	}
	const series = run("stg", ["series"], { cwd: repository, capture: true });
	const topPatch = run("stg", ["top"], { cwd: repository, capture: true }).trim();
	if (/^- /m.test(series) || topPatch !== "maint-document-upstream-patch") {
		console.error("Agent finished, but the full StGit stack is not applied with the maintenance patch on top.");
		process.exitCode = 1;
		return;
	}
	console.log("Patch repair completed. Run `pi-gpt-6 update` again to build, validate, and activate the repaired stack.");
}

function writeSetupFiles(repository) {
	mkdirSync(HOME, { recursive: true });
	mkdirSync(BIN_DIR, { recursive: true });
	writeFileSync(REPO_FILE, `${repository}\n`);
	copyFileSync(SCRIPT_PATH, LAUNCHER_FILE);
	const launcher = join(BIN_DIR, "pi-gpt-6");
	const tempLauncher = `${launcher}.tmp.${process.pid}`;
	writeFileSync(
		tempLauncher,
		`#!/bin/sh\nexec "${process.execPath}" "${LAUNCHER_FILE}" "$@"\n`,
		{ mode: 0o755 },
	);
	renameSync(tempLauncher, launcher);
}

function setup() {
	if (process.platform === "win32") throw new Error("The pi-gpt-6 launcher setup currently requires a Unix-like system.");
	const repository = SOURCE_REPO;
	mkdirSync(HOME, { recursive: true });
	stageRelease(repository);
	writeSetupFiles(repository);
	console.log(`Launcher installed at ${join(BIN_DIR, "pi-gpt-6")}`);
	if (!process.env.PATH?.split(":" ).includes(BIN_DIR)) console.log(`Add ${BIN_DIR} to PATH to run pi-gpt-6 from anywhere.`);
}

async function main() {
	const args = process.argv.slice(2);
	if (args[0] === "--setup") {
		setup();
		return;
	}
	const repository = getRepository();
	const update = classifyUpdate(args);
	if (!update || update.type === "delegate") {
		runCurrent(args);
		return;
	}
	if (update.type === "agent") {
		runAgentRepair(repository);
		return;
	}
	if (update.type === "all") {
		runCurrent(["update", "--extensions"]);
		if (process.exitCode !== 0) return;
	}
	performForkUpdate(repository);
}

if (process.argv[1] && resolve(process.argv[1]) === SCRIPT_PATH) {
	try {
		await main();
	} catch (error) {
		console.error(`pi-gpt-6: ${error instanceof Error ? error.message : String(error)}`);
		process.exitCode = 1;
	}
}

export { activateRelease, classifyUpdate, getConflictPrompt, pruneReleases, replaceCurrentLink };
