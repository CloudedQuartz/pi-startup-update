import assert from "node:assert/strict";
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import test from "node:test";

const updaterPath = join(dirname(fileURLToPath(import.meta.url)), "..", "pi-startup-update");

async function makeHarness(root, options = {}) {
	const bin = join(root, "mock-bin");
	const agentDir = options.missingAgentDir ? join(root, "missing-agent") : join(root, "agent");
	const piPath = join(root, "fake-pi");
	const piLog = join(root, "pi.log");
	const psCount = join(root, "ps.count");
	await mkdir(bin);
	if (!options.missingAgentDir) await mkdir(agentDir);

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
	await writeFile(join(bin, "flock"), `#!/usr/bin/env bash
if [[ "\${1:-}" == -u ]]; then exit 0; fi
[[ "\${MOCK_FLOCK_STATE:-ok}" == busy ]] && exit 1
exit 0
`);
	await writeFile(piPath, `#!/usr/bin/env bash
if [[ "\${1:-}" == update ]]; then
  printf 'CALL' >> "$MOCK_PI_LOG"
  printf '\\t%s' "$@" >> "$MOCK_PI_LOG"
  printf '\\n' >> "$MOCK_PI_LOG"
  case "\${MOCK_FAIL_UPDATE:-}" in
    extensions)
      [[ " $* " == *" --extensions "* ]] || exit 0
      printf 'mock extension update failure detail\\n' >&2
      exit 23
      ;;
    core)
      [[ " $* " == *" --self "* ]] || exit 0
      printf 'mock core update failure detail\\n' >&2
      exit 24
      ;;
  esac
  exit 0
fi
printf 'LAUNCH' >> "$MOCK_PI_LOG"
for arg in "$@"; do printf '\\t%s' "$arg" >> "$MOCK_PI_LOG"; done
printf '\\n' >> "$MOCK_PI_LOG"
`);
	for (const path of [join(bin, "ps"), join(bin, "flock"), piPath]) await chmod(path, 0o755);
	return { bin, agentDir, piPath, piLog, psCount };
}

function shellQuote(value) {
	return `'${value.replaceAll("'", "'\\''")}'`;
}

async function runUpdater(root, options = {}) {
	const harness = await makeHarness(root, options);
	const args = options.args ?? [];
	const command = [updaterPath, harness.piPath, ...args].map(shellQuote).join(" ");
	const env = {
		...process.env,
		PATH: `${harness.bin}:${process.env.PATH}`,
		AI_AGENT: options.aiAgent ?? "",
		PI_CODING_AGENT: options.piCodingAgent ?? "",
		PI_CODING_AGENT_DIR: options.agentDir ?? harness.agentDir,
		PI_OFFLINE: options.offline ?? "",
		MOCK_PI_LOG: harness.piLog,
		MOCK_PS_COUNT: harness.psCount,
		MOCK_PS_STATE: options.processState ?? "idle",
		MOCK_FLOCK_STATE: options.lockState ?? "ok",
		MOCK_FAIL_UPDATE: options.failUpdate ?? "",
	};
	const result = options.tty === false
		? spawnSync(updaterPath, [harness.piPath, ...args], { encoding: "utf8", env })
		: spawnSync("script", ["-q", "-e", "-c", command, "/dev/null"], { encoding: "utf8", env });
	assert.equal(result.error, undefined, `could not start mocked updater: ${result.error}`);
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

test("updates user extensions, then Pi core, before launching", async () => inTempDir(async (root) => {
	const result = await runUpdater(root);
	assert.deepEqual(result.log.trim().split("\n"), [
		"CALL\tupdate\t--extensions\t--no-approve",
		"CALL\tupdate\t--self\t--no-approve",
		"LAUNCH",
	]);
}));

test("passes Pi arguments through without invoking the updater", async () => inTempDir(async (root) => {
	const result = await runUpdater(root, { args: ["--version", "--help"] });
	assert.equal(result.log, "LAUNCH\t--version\t--help\n");
	assert.doesNotMatch(result.log, /^CALL\tupdate/m);
}));

test("bypasses updates for noninteractive, AI-agent, and offline launches", async (t) => {
	for (const [name, options] of [
		["noninteractive", { tty: false }],
		["AI_AGENT", { aiAgent: "1" }],
		["PI_CODING_AGENT", { piCodingAgent: "1" }],
		["offline", { offline: "true" }],
	]) {
		await t.test(name, async () => inTempDir(async (root) => {
			const result = await runUpdater(root, options);
			assert.equal(result.log, "LAUNCH\n");
			assert.doesNotMatch(result.log, /^CALL\tupdate/m);
		}));
	}
});

test("skips updates when pi, pi-rpc, or process inspection failure is detected", async (t) => {
	for (const processState of ["pi", "rpc", "error"]) {
		await t.test(processState, async () => inTempDir(async (root) => {
			const result = await runUpdater(root, { processState });
			assert.equal(result.log, "LAUNCH\n");
			assert.doesNotMatch(result.log, /^CALL\tupdate/m);
			assert.match(result.output, processState === "error"
				? /could not check for active Pi sessions/
				: /another Pi or Pi RPC session is active/);
		}));
	}
});

test("skips updates when another wrapper holds the lock or the lock file is unavailable", async (t) => {
	await t.test("busy lock", async () => inTempDir(async (root) => {
		const result = await runUpdater(root, { lockState: "busy" });
		assert.equal(result.log, "LAUNCH\n");
		assert.doesNotMatch(result.log, /^CALL\tupdate/m);
		assert.match(result.output, /another startup update is running/);
	}));
	await t.test("unavailable lock file", async () => inTempDir(async (root) => {
		const result = await runUpdater(root, { missingAgentDir: true });
		assert.equal(result.log, "LAUNCH\n");
		assert.doesNotMatch(result.log, /^CALL\tupdate/m);
		assert.match(result.output, /update lock is unavailable/);
	}));
});

test("rechecks for a late Pi session immediately before updating", async (t) => {
	for (const processState of ["late-rpc", "late-error"]) {
		await t.test(processState, async () => inTempDir(async (root) => {
			const result = await runUpdater(root, { processState });
			assert.equal(result.log, "LAUNCH\n");
			assert.doesNotMatch(result.log, /^CALL\tupdate/m);
			assert.match(result.output, processState === "late-error"
				? /could not recheck active Pi sessions/
				: /Pi RPC session became active/);
		}));
	}
});

test("extension update failure warns with stderr, skips core, and launches installed Pi", async () => inTempDir(async (root) => {
	const result = await runUpdater(root, { failUpdate: "extensions" });
	assert.deepEqual(result.log.trim().split("\n"), [
		"CALL\tupdate\t--extensions\t--no-approve",
		"LAUNCH",
	]);
	assert.match(result.output, /Pi extensions update failed \(exit 23\)/);
	assert.match(result.output, /mock extension update failure detail/);
	assert.match(result.output, /skipping Pi core update because the extension update failed/);
}));

test("core update failure warns with stderr and still launches installed Pi", async () => inTempDir(async (root) => {
	const result = await runUpdater(root, { failUpdate: "core" });
	assert.deepEqual(result.log.trim().split("\n"), [
		"CALL\tupdate\t--extensions\t--no-approve",
		"CALL\tupdate\t--self\t--no-approve",
		"LAUNCH",
	]);
	assert.match(result.output, /Pi core update failed \(exit 24\)/);
	assert.match(result.output, /mock core update failure detail/);
}));
