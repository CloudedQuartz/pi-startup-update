import assert from "node:assert/strict";
import { chmod, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync, spawnSync } from "node:child_process";
import test from "node:test";

const updaterPath = join(dirname(fileURLToPath(import.meta.url)), "..", "pi-startup-update");
const realGitPath = execFileSync("which", ["git"], { encoding: "utf8" }).trim();

function git(cwd, args) {
	const result = spawnSync(realGitPath, args, { cwd, encoding: "utf8" });
	assert.equal(result.status, 0, `git ${args.join(" ")} failed: ${result.stderr}`);
}

async function makeGitRepo(root) {
	const remote = join(root, "remote.git");
	const seed = join(root, "seed");
	const checkout = join(root, "checkout");
	await mkdir(seed);
	git(root, ["init", "--bare", "--initial-branch=main", remote]);
	git(root, ["init", "--initial-branch=main", seed]);
	git(seed, ["config", "user.name", "Updater Fixture"]);
	git(seed, ["config", "user.email", "updater-fixture@example.invalid"]);
	await writeFile(join(seed, "tracked.txt"), "base\n");
	git(seed, ["add", "tracked.txt"]);
	git(seed, ["commit", "-m", "base"]);
	git(seed, ["remote", "add", "origin", remote]);
	git(seed, ["push", "-u", "origin", "main"]);
	git(root, ["--git-dir", remote, "symbolic-ref", "HEAD", "refs/heads/main"]);
	git(root, ["clone", remote, checkout]);
	git(checkout, ["config", "user.name", "Updater Fixture"]);
	git(checkout, ["config", "user.email", "updater-fixture@example.invalid"]);
	return { remote, seed, checkout };
}

async function commitFile(repo, name, contents, message) {
	await writeFile(join(repo, name), contents);
	git(repo, ["add", name]);
	git(repo, ["commit", "-m", message]);
}

async function makeHarness(root, options = {}) {
	const bin = join(root, "mock-bin");
	const agentDir = join(root, "agent");
	const piPath = join(root, "fake-pi");
	const piLog = join(root, "pi.log");
	const psCount = join(root, "ps.count");
	await mkdir(bin);
	await mkdir(agentDir);
	if (!options.realResolver) {
		await writeFile(join(bin, "node"), `#!/usr/bin/env bash
if [[ "\${MOCK_RESOLVER:-ok}" == fail ]]; then exit 1; fi
case "\${MOCK_GIT_RECORD:-path}" in
  missing) printf 'git-missing\\0\\0' ;;
  path) printf 'git\\0%s\\0git-target\\0%s\\0' "\${MOCK_GIT_PATH}" "\${MOCK_GIT_REF:-}" ;;
  none) ;;
  *) exit 2 ;;
esac
if [[ "\${MOCK_NPM_RECORD:-1}" == 1 ]]; then printf 'npm\\0npm:fixture\\0'; fi
`);
	} else {
		await mkdir(join(root, "dist", "core"), { recursive: true });
		await mkdir(join(root, "dist", "utils"), { recursive: true });
		await writeFile(join(root, "package.json"), '{"type":"module"}');
		await writeFile(join(root, "dist", "core", "settings-manager.js"), `export class SettingsManager {
  static create() { return new SettingsManager(); }
  drainErrors() { return []; }
  getGlobalSettings() {
    if (process.env.MOCK_TEST_RESOLVER_THROW === "1") throw new Error("mock resolver failure");
    return { packages: [{ source: "git:example.invalid/fixture" }] };
  }
}
`);
		await writeFile(join(root, "dist", "core", "package-manager.js"), `import { existsSync } from "node:fs";
export class DefaultPackageManager {
  getInstalledPath() {
    const path = process.env.MOCK_TEST_INSTALL_PATH;
    return existsSync(path) ? path : undefined;
  }
  getGitInstallPath() { return process.env.MOCK_TEST_INSTALL_PATH; }
}
`);
		await writeFile(join(root, "dist", "utils", "git.js"), `export function parseGitUrl() {
  return { host: "example.invalid", path: "fixture", ref: process.env.MOCK_TEST_SOURCE_REF || undefined };
}
`);
	}
	await writeFile(join(bin, "ps"), `#!/usr/bin/env bash
case "\${MOCK_PS_STATE:-idle}" in
  error) exit 2 ;;
  pi) printf 'pi\\n'; exit 0 ;;
  rpc) printf 'pi-rpc\\n'; exit 0 ;;
  late-rpc|late-error)
    count=0
    [[ -r "$MOCK_PS_COUNT" ]] && read -r count < "$MOCK_PS_COUNT"
    count=$((count + 1))
    printf '%s\\n' "$count" > "$MOCK_PS_COUNT"
    if (( count >= 2 )); then
      [[ "$MOCK_PS_STATE" == late-error ]] && exit 2
      printf 'pi-rpc\\n'
    else
      printf 'bash\\n'
    fi
    exit 0
    ;;
esac
printf 'bash\\n'
`);
	await writeFile(join(bin, "git"), `#!/usr/bin/env bash
case "\${MOCK_GIT_FAIL:-}" in
  1|all) exit 1 ;;
  merge-base) [[ "$3" == merge-base ]] && exit 2 ;;
  upstream) [[ "$3" == rev-parse && "$4" == --abbrev-ref ]] && exit 1 ;;
esac
exec "\${MOCK_REAL_GIT}" "$@"
`);
	await writeFile(piPath, `#!/usr/bin/env bash
if (( $# == 0 )); then
  printf 'LAUNCH\\n' >> "$MOCK_PI_LOG"
else
  printf 'CALL' >> "$MOCK_PI_LOG"
  printf '\\t%s' "$@" >> "$MOCK_PI_LOG"
  printf '\\n' >> "$MOCK_PI_LOG"
fi
`);
	const executablePaths = [join(bin, "ps"), join(bin, "git"), piPath];
	if (!options.realResolver) executablePaths.push(join(bin, "node"));
	for (const path of executablePaths) await chmod(path, 0o755);
	return { bin, agentDir, piPath, piLog, psCount };
}

function shellQuote(value) {
	return `'${value.replaceAll("'", "'\\''")}'`;
}

async function runUpdater(root, options = {}) {
	const harness = await makeHarness(root, options);
	const result = spawnSync(
		"script",
		["-q", "-e", "-c", `${shellQuote(updaterPath)} ${shellQuote(harness.piPath)}`, "/dev/null"],
		{
			encoding: "utf8",
			env: {
				...process.env,
				PATH: `${harness.bin}:${process.env.PATH}`,
				AI_AGENT: "",
				PI_CODING_AGENT: "",
				PI_CODING_AGENT_DIR: harness.agentDir,
				PI_OFFLINE: "",
				TMPDIR: root,
				MOCK_PI_LOG: harness.piLog,
				MOCK_PS_COUNT: harness.psCount,
				MOCK_REAL_GIT: realGitPath,
				MOCK_GIT_PATH: options.gitPath ?? "",
				MOCK_GIT_REF: options.gitRef ?? "",
				MOCK_GIT_RECORD: options.gitRecord ?? "path",
				MOCK_GIT_FAIL: options.gitFail === true ? "all" : options.gitFail ?? "",
				MOCK_TEST_INSTALL_PATH: options.installPath ?? join(root, "not-installed", "fixture"),
				MOCK_TEST_SOURCE_REF: options.gitRef ?? "",
				MOCK_TEST_RESOLVER_THROW: options.resolverThrow ? "1" : "0",
				MOCK_NPM_RECORD: options.npmRecord === false ? "0" : "1",
				MOCK_RESOLVER: options.resolver ?? "ok",
				MOCK_PS_STATE: options.processState ?? "idle",
			},
		},
	);
	assert.equal(result.error, undefined, `could not start mocked TTY: ${result.error}`);
	assert.equal(result.status, 0, `updater exited ${result.status}: ${result.stdout}\n${result.stderr}`);
	const log = await readFile(harness.piLog, "utf8");
	return { ...harness, log, output: `${result.stdout}\n${result.stderr}` };
}

async function inTempDir(run) {
	const root = await mkdtemp(join(tmpdir(), "pi-startup-update-test-"));
	try {
		await run(root);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
}

test("updates all packages for an equal or behind clean checkout", async (t) => {
	for (const state of ["equal", "behind"]) {
		await t.test(state, async () => inTempDir(async (root) => {
			const { seed, checkout } = await makeGitRepo(root);
			if (state === "behind") {
				await commitFile(seed, "remote.txt", "remote\n", "remote advance");
				git(seed, ["push", "origin", "main"]);
				git(checkout, ["fetch", "origin"]);
			}
			const result = await runUpdater(root, { gitPath: checkout });
			assert.match(result.log, /^CALL\tupdate\t--all\t--no-approve$/m, result.output);
			assert.doesNotMatch(result.log, /^CALL\tupdate\tnpm:fixture/m);
		}));
	}
});

test("skips Git updates for local-only ahead and diverged commits", async (t) => {
	for (const state of ["ahead", "diverged"]) {
		await t.test(state, async () => inTempDir(async (root) => {
			const { seed, checkout } = await makeGitRepo(root);
			await commitFile(checkout, "local.txt", "local\n", "local-only commit");
			if (state === "diverged") {
				await commitFile(seed, "remote.txt", "remote\n", "remote-only commit");
				git(seed, ["push", "origin", "main"]);
				git(checkout, ["fetch", "origin"]);
			}
			const result = await runUpdater(root, { gitPath: checkout });
			assert.doesNotMatch(result.log, /^CALL\tupdate\t--all/m);
			assert.match(result.log, /^CALL\tupdate\tnpm:fixture\t--no-approve$/m);
			assert.match(result.log, /^CALL\tupdate\t--self\t--no-approve$/m);
			assert.match(result.output, /commits outside the Pi update target/);
		}));
	}
});

test("fails closed rather than comparing a pinned Git ref to an unrelated upstream", async () => inTempDir(async (root) => {
	const { seed, checkout } = await makeGitRepo(root);
	git(seed, ["tag", "v1"]);
	git(seed, ["push", "origin", "v1"]);
	await commitFile(seed, "newer.txt", "newer\n", "advance main beyond pin");
	git(seed, ["push", "origin", "main"]);
	git(checkout, ["fetch", "origin"]);
	git(checkout, ["pull", "--ff-only"]);
	const result = await runUpdater(root, { gitPath: checkout, gitRef: "v1" });
	assert.doesNotMatch(result.log, /^CALL\tupdate\t--all/m);
	assert.match(result.log, /^CALL\tupdate\tnpm:fixture\t--no-approve$/m);
	assert.match(result.log, /^CALL\tupdate\t--self\t--no-approve$/m);
	assert.match(result.output, /could not be verified/);
}));

test("does not mistake a local branch name for Pi's fetched configured target", async () => inTempDir(async (root) => {
	const { checkout } = await makeGitRepo(root);
	await commitFile(checkout, "local-only.txt", "local\n", "local-only commit on main");
	const result = await runUpdater(root, {
		realResolver: true,
		installPath: checkout,
		gitRef: "main",
		npmRecord: false,
	});
	assert.doesNotMatch(result.log, /^CALL\tupdate\t--all/m);
	assert.match(result.log, /^CALL\tupdate\t--self\t--no-approve$/m);
	assert.match(result.output, /could not be verified/);
}));

test("fails closed when a configured Git ref is absent locally", async () => inTempDir(async (root) => {
	const { checkout } = await makeGitRepo(root);
	const result = await runUpdater(root, {
		realResolver: true,
		installPath: checkout,
		gitRef: "not-present-locally",
		npmRecord: false,
	});
	assert.doesNotMatch(result.log, /^CALL\tupdate\t--all/m);
	assert.match(result.log, /^CALL\tupdate\t--self\t--no-approve$/m);
	assert.match(result.output, /could not be verified/);
}));

test("fails closed when no upstream or origin/HEAD comparison exists", async () => inTempDir(async (root) => {
	const { checkout } = await makeGitRepo(root);
	git(checkout, ["branch", "--unset-upstream"]);
	git(checkout, ["symbolic-ref", "--delete", "refs/remotes/origin/HEAD"]);
	const result = await runUpdater(root, { gitPath: checkout });
	assert.doesNotMatch(result.log, /^CALL\tupdate\t--all/m);
	assert.match(result.log, /^CALL\tupdate\t--self\t--no-approve$/m);
	assert.match(result.output, /could not be verified/);
}));

test("fails closed when Git comparison or upstream commands fail", async (t) => {
	for (const gitFail of ["all", "merge-base", "upstream"]) {
		await t.test(gitFail, async () => inTempDir(async (root) => {
			const { checkout } = await makeGitRepo(root);
			const result = await runUpdater(root, { gitPath: checkout, gitFail });
			assert.doesNotMatch(result.log, /^CALL\tupdate\t--all/m);
			assert.match(result.log, /^CALL\tupdate\t--self\t--no-approve$/m);
			assert.match(result.output, /could not be verified/);
		}));
	}
});

test("distinguishes a missing Git package from an unverifiable installation path", async (t) => {
	await t.test("installs a confirmed missing package when checks are safe", async () => inTempDir(async (root) => {
		const result = await runUpdater(root, { gitRecord: "missing" });
		assert.match(result.log, /^CALL\tupdate\t--all\t--no-approve$/m);
	}));
	await t.test("does not update an unverifiable path", async () => inTempDir(async (root) => {
		const result = await runUpdater(root, { gitPath: join(root, "not-a-repository") });
		assert.doesNotMatch(result.log, /^CALL\tupdate\t--all/m);
		assert.match(result.log, /^CALL\tupdate\t--self\t--no-approve$/m);
		assert.match(result.output, /could not be verified/);
	}));
});

test("resolves missing versus unverifiable paths using the embedded resolver", async (t) => {
	await t.test("confirms an absent install directory", async () => inTempDir(async (root) => {
		const result = await runUpdater(root, {
			realResolver: true,
			installPath: join(root, "missing", "nested", "fixture"),
			npmRecord: false,
		});
		assert.match(result.log, /^CALL\tupdate\t--all\t--no-approve$/m);
	}));
	await t.test("rejects an inaccessible install parent", async (t) => inTempDir(async (root) => {
		if (typeof process.getuid === "function" && process.getuid() === 0) {
			t.skip("root can bypass directory permission checks");
			return;
		}
		const parent = join(root, "private");
		await mkdir(parent);
		const installPath = join(parent, "fixture");
		await chmod(parent, 0);
		let result;
		try {
			result = await runUpdater(root, { realResolver: true, installPath, npmRecord: false });
		} finally {
			await chmod(parent, 0o700);
		}
		assert.match(result.log, /^CALL\tupdate\t--self\t--no-approve$/m);
		assert.doesNotMatch(result.log, /^CALL\tupdate\t--all/m);
		assert.match(result.output, /configured packages could not be resolved/);
	}));
	await t.test("treats a file at the expected install path as unverifiable", async () => inTempDir(async (root) => {
		const installPath = join(root, "not-a-directory");
		await writeFile(installPath, "file\n");
		const result = await runUpdater(root, { realResolver: true, installPath, npmRecord: false });
		assert.doesNotMatch(result.log, /^CALL\tupdate\t--all/m);
		assert.match(result.log, /^CALL\tupdate\t--self\t--no-approve$/m);
	}));
	await t.test("treats a dangling leaf symlink as unverifiable", async () => inTempDir(async (root) => {
		const installPath = join(root, "dangling-leaf");
		await symlink(join(root, "absent-target"), installPath);
		const result = await runUpdater(root, { realResolver: true, installPath, npmRecord: false });
		assert.doesNotMatch(result.log, /^CALL\tupdate\t--all/m);
		assert.match(result.log, /^CALL\tupdate\t--self\t--no-approve$/m);
	}));
	await t.test("does not classify a dangling ancestor symlink as absence", async () => inTempDir(async (root) => {
		const danglingParent = join(root, "dangling-parent");
		await symlink(join(root, "absent-target"), danglingParent);
		const result = await runUpdater(root, {
			realResolver: true,
			installPath: join(danglingParent, "fixture"),
			npmRecord: false,
		});
		assert.doesNotMatch(result.log, /^CALL\tupdate\t--all/m);
		assert.match(result.log, /^CALL\tupdate\t--self\t--no-approve$/m);
		assert.match(result.output, /configured packages could not be resolved/);
	}));
	await t.test("falls back when resolver modules throw", async () => inTempDir(async (root) => {
		const result = await runUpdater(root, { realResolver: true, resolverThrow: true });
		assert.doesNotMatch(result.log, /^CALL\tupdate\t--all/m);
		assert.doesNotMatch(result.log, /^CALL\tupdate\tnpm:/m);
		assert.match(result.log, /^CALL\tupdate\t--self\t--no-approve$/m);
		assert.match(result.output, /falling back to a core-only update/);
	}));
});

test("blocks updates for active pi and pi-rpc processes, and when process inspection fails", async (t) => {
	for (const processState of ["pi", "rpc", "error"]) {
		await t.test(processState, async () => inTempDir(async (root) => {
			const result = await runUpdater(root, { processState });
			assert.doesNotMatch(result.log, /^CALL\tupdate/m);
			assert.match(result.log, /^LAUNCH$/m);
			if (processState === "error") {
				assert.match(result.output, /could not check for active Pi sessions/);
			} else {
				assert.match(result.output, /another Pi or Pi RPC session is active/);
			}
		}));
	}
});

test("uses core-only fallback after resolver failure, but still honors the active-session recheck", async (t) => {
	await t.test("idle session", async () => inTempDir(async (root) => {
		const result = await runUpdater(root, { resolver: "fail" });
		assert.match(result.log, /^CALL\tupdate\t--self\t--no-approve$/m);
		assert.doesNotMatch(result.log, /^CALL\tupdate\t--all/m);
		assert.doesNotMatch(result.log, /^CALL\tupdate\tnpm:/m);
		assert.match(result.output, /falling back to a core-only update/);
	}));
	await t.test("pi-rpc starts before the second gate", async () => inTempDir(async (root) => {
		const result = await runUpdater(root, { resolver: "fail", processState: "late-rpc" });
		assert.doesNotMatch(result.log, /^CALL\tupdate/m);
		assert.match(result.log, /^LAUNCH$/m);
		assert.match(result.output, /Pi RPC session became active/);
	}));
	await t.test("second process inspection fails", async () => inTempDir(async (root) => {
		const result = await runUpdater(root, { resolver: "fail", processState: "late-error" });
		assert.doesNotMatch(result.log, /^CALL\tupdate/m);
		assert.match(result.log, /^LAUNCH$/m);
		assert.match(result.output, /could not recheck active Pi sessions/);
	}));
});

test("an ignored-only build directory remains unsafe because Pi cleans with -fdx", async () => inTempDir(async (root) => {
	const { checkout, seed } = await makeGitRepo(root);
	await writeFile(join(seed, ".gitignore"), "build/\n");
	git(seed, ["add", ".gitignore"]);
	git(seed, ["commit", "-m", "ignore build output"]);
	git(seed, ["push", "origin", "main"]);
	git(checkout, ["pull", "--ff-only"]);
	await mkdir(join(checkout, "build"));
	await writeFile(join(checkout, "build", "artifact"), "ignored\n");
	const result = await runUpdater(root, { gitPath: checkout });
	assert.doesNotMatch(result.log, /^CALL\tupdate\t--all/m);
	assert.match(result.log, /^CALL\tupdate\t--self\t--no-approve$/m);
	assert.match(result.output, /dirty or has ignored files Pi would clean/);
}));
