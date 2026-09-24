import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { activateRelease, classifyUpdate, pruneReleases, replaceCurrentLink } from "./pi-gpt-6.mjs";

const launcherScript = fileURLToPath(new URL("./pi-gpt-6.mjs", import.meta.url));
const packageCli = "node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js";

function makeRelease(home, timestamp, hash = "0123456789ab") {
	const name = `${hash}-${timestamp}`;
	mkdirSync(join(home, "releases", name), { recursive: true });
	return name;
}

function runGit(repository, args) {
	const result = spawnSync("git", args, { cwd: repository, encoding: "utf8" });
	assert.equal(result.status, 0, result.stderr);
}

function makeConflictRepository(root) {
	const repository = join(root, "repo");
	mkdirSync(repository);
	runGit(repository, ["init", "-b", "main"]);
	runGit(repository, ["config", "user.email", "test@example.com"]);
	runGit(repository, ["config", "user.name", "Test"]);
	writeFileSync(join(repository, "conflict.txt"), "base\n");
	runGit(repository, ["add", "."]);
	runGit(repository, ["commit", "-m", "base"]);
	runGit(repository, ["checkout", "-b", "upstream-change"]);
	writeFileSync(join(repository, "conflict.txt"), "upstream\n");
	runGit(repository, ["commit", "-am", "upstream"]);
	runGit(repository, ["checkout", "main"]);
	writeFileSync(join(repository, "conflict.txt"), "local\n");
	runGit(repository, ["commit", "-am", "local"]);
	const merge = spawnSync("git", ["merge", "upstream-change"], { cwd: repository, encoding: "utf8" });
	assert.notEqual(merge.status, 0, "fixture must have an unresolved merge conflict");
	mkdirSync(join(repository, "scripts"));
	writeFileSync(join(repository, "scripts", "update-from-upstream.sh"), "#!/bin/sh\nexit 1\n");
	chmodSync(join(repository, "scripts", "update-from-upstream.sh"), 0o755);
	return repository;
}


test("routes self-update aliases to fork maintenance", () => {
	for (const args of [["update"], ["update", "--self"], ["update", "self"], ["update", "pi"], ["update", "--force"], ["update", "--self", "--force"]]) {
		assert.equal(classifyUpdate(args)?.type, "self", args.join(" "));
	}
});

test("updates the fork and delegates package updates for --all aliases", () => {
	for (const args of [["update", "--all"], ["update", "--self", "--extensions"], ["update", "pi", "--extensions"]]) {
		assert.equal(classifyUpdate(args)?.type, "all", args.join(" "));
	}
});

test("delegates package, model, and extension-only updates unchanged", () => {
	for (const args of [
		["update", "--extensions"],
		["update", "--models"],
		["update", "npm:@foo/bar"],
		["update", "--extension", "npm:@foo/bar"],
	]) {
		assert.equal(classifyUpdate(args)?.type, "delegate", args.join(" "));
	}
});

test("does not intercept invalid update combinations", () => {
	assert.equal(classifyUpdate(["update", "--all", "--models"]), undefined);
	assert.equal(classifyUpdate(["update", "--all", "--extensions"]), undefined);
	assert.equal(classifyUpdate(["update", "--agent", "--all"]), undefined);
});

test("atomically switches current while retaining the previous release", () => {
	const root = mkdtempSync(join(tmpdir(), "pi-gpt-6-link-test-"));
	try {
		const releases = join(root, "releases");
		const current = join(root, "current");
		const previous = join(releases, "old");
		const next = join(releases, "new");
		mkdirSync(releases);
		writeFileSync(previous, "old");
		writeFileSync(next, "new");
		symlinkSync(previous, current);
		replaceCurrentLink(next, root);
		assert.equal(readlinkSync(current), next);
		assert.equal(existsSync(previous), true);
		assert.equal(readFileSync(previous, "utf8"), "old");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("release pruning retains active plus five newest previous releases and ignores unexpected entries", () => {
	const root = mkdtempSync(join(tmpdir(), "pi-gpt-6-retention-test-"));
	try {
		const releasesDir = join(root, "releases");
		mkdirSync(releasesDir);
		const names = Array.from({ length: 9 }, (_, index) => makeRelease(root, `2026010100000${index}`, (15 - index).toString(16).padStart(12, "0")));
		const active = join(releasesDir, names[0]);
		symlinkSync(active, join(root, "current"));
		writeFileSync(join(releasesDir, "notes.txt"), "keep me");
		symlinkSync(names[8], join(releasesDir, "unexpected-link"));
		const retained = pruneReleases(root);
		assert.deepEqual(new Set(retained), new Set([names[0], ...names.slice(4)]));
		assert.deepEqual(new Set(readdirSync(releasesDir).filter((name) => /^[a-f0-9]{12}-/.test(name)) ), new Set([names[0], ...names.slice(4)]));
		assert.equal(readFileSync(join(releasesDir, "notes.txt"), "utf8"), "keep me");
		assert.equal(readlinkSync(join(releasesDir, "unexpected-link")), names[8]);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("successful activation prunes to the active release plus five newest previous releases", () => {
	const root = mkdtempSync(join(tmpdir(), "pi-gpt-6-activation-retention-"));
	try {
		const names = Array.from({ length: 9 }, (_, index) => makeRelease(root, `2026021500000${index}`));
		const next = join(root, "releases", names[8]);
		symlinkSync(join(root, "releases", names[7]), join(root, "current"));
		activateRelease(next, root);
		assert.equal(readlinkSync(join(root, "current")), next);
		assert.deepEqual(new Set(readdirSync(join(root, "releases"))), new Set(names.slice(3)));
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("release pruning leaves fewer-than-limit and exactly-limit sets unchanged", () => {
	for (const count of [3, 6]) {
		const root = mkdtempSync(join(tmpdir(), "pi-gpt-6-retention-boundary-"));
		try {
			const names = Array.from({ length: count }, (_, index) => makeRelease(root, `2026020100000${index}`));
			symlinkSync(join(root, "releases", names[0]), join(root, "current"));
			assert.equal(pruneReleases(root).length, count);
			assert.equal(readdirSync(join(root, "releases")).length, count);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	}
});

test("failed activation does not prune releases", () => {
	const root = mkdtempSync(join(tmpdir(), "pi-gpt-6-activation-failure-"));
	try {
		const names = Array.from({ length: 8 }, (_, index) => makeRelease(root, `2026030100000${index}`));
		mkdirSync(join(root, "current")); // A directory makes atomic symlink replacement fail.
		assert.throws(() => activateRelease(join(root, "releases", names[7]), root));
		assert.equal(readdirSync(join(root, "releases")).length, names.length);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("normal update stops on conflict without invoking the agent and writes a repair prompt", () => {
	const root = mkdtempSync(join(tmpdir(), "pi-gpt-6-conflict-no-agent-"));
	try {
		const repository = makeConflictRepository(root);
		const home = join(root, "home");
		const agentMarker = join(root, "agent-invoked");
		mkdirSync(join(home, "current", "node_modules", "@earendil-works", "pi-coding-agent", "dist", "bundle"), { recursive: true });
		writeFileSync(join(home, "current", packageCli), `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(agentMarker)}, "called");\n`);
		const result = spawnSync(process.execPath, [launcherScript, "update"], {
			cwd: root,
			encoding: "utf8",
			env: { ...process.env, PI_GPT6_REPO: repository, PI_GPT6_HOME: home },
		});
		assert.notEqual(result.status, 0);
		assert.equal(existsSync(agentMarker), false);
		const prompt = join(repository, ".git", "pi-gpt-6", "update-agent-prompt.md");
		assert.equal(existsSync(prompt), true);
		assert.match(result.stderr, /currently installed pi-gpt-6 is unchanged and still usable/);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("update --all can stop on conflict without invoking agent repair", () => {
	const root = mkdtempSync(join(tmpdir(), "pi-gpt-6-all-conflict-no-agent-"));
	try {
		const repository = makeConflictRepository(root);
		const home = join(root, "home");
		const cliCalls = join(root, "cli-calls");
		mkdirSync(join(home, "current", "node_modules", "@earendil-works", "pi-coding-agent", "dist", "bundle"), { recursive: true });
		writeFileSync(join(home, "current", packageCli), `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(cliCalls)}, process.argv.slice(2).join(" "));\n`);
		const result = spawnSync(process.execPath, [launcherScript, "update", "--all"], {
			cwd: root,
			encoding: "utf8",
			env: { ...process.env, PI_GPT6_REPO: repository, PI_GPT6_HOME: home },
		});
		assert.notEqual(result.status, 0);
		assert.equal(readFileSync(cliCalls, "utf8"), "update --extensions");
		assert.doesNotMatch(readFileSync(cliCalls, "utf8"), /--agent/);
		assert.equal(existsSync(join(repository, ".git", "pi-gpt-6", "update-agent-prompt.md")), true);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("update --agent invokes the installed CLI only when explicitly requested", () => {
	const root = mkdtempSync(join(tmpdir(), "pi-gpt-6-explicit-agent-"));
	try {
		const repository = makeConflictRepository(root);
		const home = join(root, "home");
		const marker = join(root, "agent-invoked");
		const cli = join(home, "current", packageCli);
		mkdirSync(join(cli, ".."), { recursive: true });
		writeFileSync(cli, `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(marker)}, process.cwd());\n`);
		const result = spawnSync(process.execPath, [launcherScript, "update", "--agent"], {
			cwd: root,
			encoding: "utf8",
			env: { ...process.env, PI_GPT6_REPO: repository, PI_GPT6_HOME: home },
		});
		assert.notEqual(result.status, 0); // The mock agent intentionally leaves the conflict unresolved.
		assert.equal(readFileSync(marker, "utf8"), repository);
		assert.match(result.stdout, /Running conflict resolver using the installed pi-gpt-6 release/);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("runtime upstream update script does not push either fork branch", () => {
	const updateScript = readFileSync(new URL("./update-from-upstream.sh", import.meta.url), "utf8");
	assert.doesNotMatch(updateScript, /\\bgit\\s+push\\b/);
});
