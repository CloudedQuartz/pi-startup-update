import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test, { after } from "node:test";

const root = await mkdtemp(join(tmpdir(), "pi-startup-update-test-"));
const agentDir = join(root, "agent");
const cliEntry = "/opt/pi-coding-agent/dist/bundle/cli.js";
globalThis.__piStartupUpdateAgentDir = agentDir;

const extensionPath = join(root, "startup-update.mts");
const extensionSource = await readFile(new URL("../startup-update.ts", import.meta.url), "utf8");
const piImport = 'import { getAgentDir } from "@earendil-works/pi-coding-agent";';
assert.ok(extensionSource.includes(piImport), "expected the Pi runtime import to be mockable");
await writeFile(
	extensionPath,
	extensionSource.replace(piImport, "const getAgentDir = () => globalThis.__piStartupUpdateAgentDir;"),
);
const startupUpdate = (await import(pathToFileURL(extensionPath).href)).default;

after(async () => {
	delete globalThis.__piStartupUpdateAgentDir;
	await rm(root, { recursive: true, force: true });
});

const success = { stdout: "", stderr: "", code: 0, killed: false };

function currentProcessList() {
	return `${process.pid} node ${process.execPath} ${process.argv[1] ?? ""}\n`;
}

function createHarness(options = {}) {
	const calls = [];
	const notifications = [];
	const statuses = [];
	let handler;
	const pi = {
		on(event, callback) {
			assert.equal(event, "session_start");
			handler = callback;
		},
		async exec(command, args, execOptions) {
			calls.push({ command, args, options: execOptions });
			if (options.execute) return options.execute(command, args, execOptions);
			if (options.throwOn === command) throw new Error("mock subprocess secret");
			if (command === "ps") {
				return options.processResult ?? { ...success, stdout: options.processes ?? currentProcessList() };
			}
			if (command === "flock") return options.updateResult ?? success;
			throw new Error(`unexpected command: ${command}`);
		},
	};
	startupUpdate(pi);
	return {
		calls,
		notifications,
		statuses,
		handler,
		context: { mode: options.mode ?? "tui", ui: {
			setStatus: (...args) => statuses.push(args),
			notify: (...args) => notifications.push(args),
		} },
	};
}

async function withInvocation(options, run) {
	const oldArgv = process.argv.slice();
	const keys = ["PI_OFFLINE", "PI_SESSION_ID", "AI_AGENT", "PI_CODING_AGENT"];
	const oldEnv = new Map(keys.map((key) => [key, process.env[key]]));
	const argv = options.argv ?? [process.execPath, cliEntry];
	process.argv.splice(0, process.argv.length, ...argv);
	for (const key of keys) {
		if (options.env?.[key] === undefined) delete process.env[key];
		else process.env[key] = options.env[key];
	}
	try {
		return await run();
	} finally {
		process.argv.splice(0, process.argv.length, ...oldArgv);
		for (const [key, value] of oldEnv) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	}
}

async function run(options = {}) {
	return withInvocation(options, async () => {
		const harness = createHarness(options);
		await harness.handler({ reason: options.reason ?? "startup" }, harness.context);
		return harness;
	});
}

test("factory defers work and runs Pi's bundled CLI through the update lock", async () => withInvocation({}, async () => {
	const harness = createHarness();
	assert.equal(harness.calls.length, 0, "factory must not start subprocesses");
	await harness.handler({ reason: "startup" }, harness.context);

	assert.deepEqual(harness.calls.map(({ command }) => command), ["ps", "flock"]);
	assert.deepEqual(harness.calls[0], {
		command: "ps",
		args: ["-eo", "pid=,comm=,args="],
		options: { timeout: 2_000 },
	});
	assert.deepEqual(harness.calls[1], {
		command: "flock",
		args: [
			"-n", "-E", "75", join(agentDir, ".startup-auto-update.lock"),
			process.execPath, cliEntry, "update", "--all", "--no-approve",
		],
		options: undefined,
	});
	assert.deepEqual(harness.statuses.map(([, value]) => value), [
		"Checking for other Pi sessions…",
		"Updating Pi packages and core…",
		undefined,
	]);
	assert.deepEqual(harness.notifications, [[
		"Pi startup update completed; changes take effect on the next launch.", "info",
	]]);
}));

test("uses the resolved Node CLI entry for bundled and unbundled installs", async (t) => {
	for (const entry of [
		"/opt/pi-coding-agent/dist/bundle/cli.js",
		"/opt/pi-coding-agent/dist/cli.js",
	]) {
		await t.test(entry, async () => {
			const harness = await run({ argv: [process.execPath, entry] });
			assert.equal(harness.calls[1].args[4], process.execPath);
			assert.equal(harness.calls[1].args[5], entry);
			assert.deepEqual(harness.calls[1].args.slice(6), ["update", "--all", "--no-approve"]);
		});
	}
});

test("runs once even if startup is dispatched concurrently", async () => withInvocation({}, async () => {
	const harness = createHarness({
		execute: async (command) => {
			await new Promise((resolve) => setImmediate(resolve));
			return command === "ps" ? { ...success, stdout: currentProcessList() } : success;
		},
	});
	await Promise.all([
		harness.handler({ reason: "startup" }, harness.context),
		harness.handler({ reason: "startup" }, harness.context),
	]);
	assert.deepEqual(harness.calls.map(({ command }) => command), ["ps", "flock"]);
}));

test("skips non-startup, non-TUI, argumented, offline, and nested launches", async (t) => {
	const cases = [
		["reload", { reason: "reload" }],
		["session resume", { reason: "resume" }],
		["RPC mode", { mode: "rpc" }],
		["print mode", { mode: "print" }],
		["CLI arguments", { argv: [process.execPath, cliEntry, "--continue"] }],
		["missing CLI entry", { argv: [process.execPath] }],
		["offline", { env: { PI_OFFLINE: "1" } }],
		["nested session", { env: { PI_SESSION_ID: "nested-session" } }],
	];
	for (const [name, options] of cases) {
		await t.test(name, async () => {
			const harness = await run(options);
			assert.deepEqual(harness.calls, []);
			assert.deepEqual(harness.statuses, []);
			assert.deepEqual(harness.notifications, []);
		});
	}
});

test("does not use AI_AGENT or PI_CODING_AGENT as a skip condition", async () => {
	const harness = await run({ env: { AI_AGENT: "1", PI_CODING_AGENT: "1" } });
	assert.deepEqual(harness.calls.map(({ command }) => command), ["ps", "flock"]);
});

test("skips when another named Pi or Node-based Pi process is active", async (t) => {
	const ownProcess = `${process.pid} node ${process.execPath} ${cliEntry}`;
	const cases = [
		["pi", "123 pi /usr/local/bin/pi"],
		["pi-rpc", "123 pi-rpc /usr/local/bin/pi-rpc"],
		["Node bundled CLI", "123 node /usr/bin/node /opt/pi-coding-agent/dist/bundle/cli.js --continue"],
	];
	for (const [name, otherProcess] of cases) {
		await t.test(name, async () => {
			const harness = await run({ processes: `${ownProcess}\n${otherProcess}\n` });
			assert.deepEqual(harness.calls.map(({ command }) => command), ["ps"]);
			assert.deepEqual(harness.notifications, [[
				"Startup update skipped because another Pi session is active.", "info",
			]]);
			assert.equal(harness.statuses.at(-1)[1], undefined);
		});
	}
	await t.test("ignores this process while scanning", async () => {
		const harness = await run({ processes: ownProcess });
		assert.deepEqual(harness.calls.map(({ command }) => command), ["ps", "flock"]);
	});
});

test("skips safely when process inspection fails or times out", async (t) => {
	for (const [name, options] of [
		["nonzero exit", { processResult: { ...success, code: 1, stderr: "secret process output" } }],
		["killed inspection", { processResult: { ...success, killed: true } }],
		["thrown inspection", { throwOn: "ps" }],
		["empty output", { processResult: { ...success, stdout: "" } }],
		["malformed output", { processResult: { ...success, stdout: "not ps output\\n" } }],
	]) {
		await t.test(name, async () => {
			const harness = await run(options);
			assert.deepEqual(harness.calls.map(({ command }) => command), ["ps"]);
			assert.deepEqual(harness.notifications, [[
				"Startup update skipped: could not inspect running Pi sessions.", "warning",
			]]);
			assert.equal(harness.statuses.at(-1)[1], undefined);
			assert.doesNotMatch(JSON.stringify(harness.notifications), /secret/);
		});
	}
});

test("reports exit 75 conservatively and handles update failures without exposing subprocess output", async (t) => {
	await t.test("ambiguous exit 75", async () => {
		const harness = await run({ updateResult: { ...success, code: 75 } });
		assert.deepEqual(harness.calls.map(({ command }) => command), ["ps", "flock"]);
		assert.deepEqual(harness.notifications, [[
			"Pi startup update returned exit 75 (lock conflict or updater status); this session will continue.", "warning",
		]]);
	});
	await t.test("nonzero update", async () => {
		const harness = await run({ updateResult: { ...success, code: 23, stderr: "secret updater output" } });
		assert.deepEqual(harness.notifications, [[
			"Pi startup update failed (exit 23); this session will continue.", "warning",
		]]);
		assert.doesNotMatch(JSON.stringify(harness.notifications), /secret/);
		assert.equal(harness.statuses.at(-1)[1], undefined);
	});
	await t.test("interrupted update", async () => {
		const harness = await run({ updateResult: { ...success, code: 1, killed: true } });
		assert.deepEqual(harness.notifications, [[
			"Pi startup update was interrupted; this session will continue without retrying.", "warning",
		]]);
	});
	await t.test("thrown update", async () => {
		const harness = await run({ throwOn: "flock" });
		assert.deepEqual(harness.notifications, [[
			"Pi startup update could not run; this session will continue without retrying.", "warning",
		]]);
		assert.doesNotMatch(JSON.stringify(harness.notifications), /secret/);
	});
});
