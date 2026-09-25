import assert from "node:assert/strict";
import test from "node:test";

const { default: startupUpdate } = await import(new URL("../startup-update.ts", import.meta.url).href);

const success = { code: 0, killed: false, stdout: "", stderr: "" };

const flush = () => new Promise((resolve) => setImmediate(resolve));

function createDeferred() {
	let resolve;
	let reject;
	const promise = new Promise((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

function createHarness(options = {}) {
	const calls = [];
	const notifications = [];
	let handler;
	const pi = {
		on(event, callback) {
			assert.equal(event, "session_start");
			handler = callback;
		},
		exec(command, args) {
			calls.push({ command, args });
			if (options.deferred) return options.deferred.promise;
			if (options.throwExec) return Promise.reject(new Error("mock exec failure"));
			return Promise.resolve(options.result ?? success);
		},
	};
	startupUpdate(pi);
	return {
		calls,
		notifications,
		handler,
		context: { mode: options.mode ?? "tui", ui: { notify: (...args) => notifications.push(args) } },
	};
}

test("factory registers the handler without spawning anything", () => {
	const harness = createHarness();
	assert.equal(typeof harness.handler, "function");
	assert.deepEqual(harness.calls, []);
});

test("startup in TUI runs the builtin updater with --all --no-approve", async () => {
	const harness = createHarness();
	harness.handler({ reason: "startup" }, harness.context);
	assert.deepEqual(harness.calls, [{
		command: process.execPath,
		args: [process.argv[1], "update", "--all", "--no-approve"],
	}]);
	await flush();
	assert.deepEqual(harness.notifications, [[
		"Pi startup update completed; changes take effect on the next launch.", "info",
	]]);
});

test("handler returns before the updater settles and notifies later", async () => {
	const deferred = createDeferred();
	const harness = createHarness({ deferred });
	const returned = harness.handler({ reason: "startup" }, harness.context);
	assert.equal(returned, undefined);
	assert.equal(harness.calls.length, 1);
	assert.deepEqual(harness.notifications, []);
	await flush();
	assert.deepEqual(harness.notifications, []);
	deferred.resolve(success);
	await flush();
	assert.deepEqual(harness.notifications, [[
		"Pi startup update completed; changes take effect on the next launch.", "info",
	]]);
});

test("skips reloads, in-session switches, and non-TUI modes", async () => {
	const cases = [
		[{ reason: "reload" }, "tui"],
		[{ reason: "resume" }, "tui"],
		[{ reason: "startup" }, "print"],
		[{ reason: "startup" }, "rpc"],
	];
	for (const [event, mode] of cases) {
		const harness = createHarness({ mode });
		harness.handler(event, harness.context);
		assert.deepEqual(harness.calls, []);
		assert.deepEqual(harness.notifications, []);
	}
});

test("reports a nonzero updater exit without exposing subprocess output", async () => {
	const harness = createHarness({ result: { ...success, code: 23, stderr: "secret updater output" } });
	harness.handler({ reason: "startup" }, harness.context);
	assert.equal(harness.calls.length, 1);
	await flush();
	assert.deepEqual(harness.notifications, [[
		"Pi startup update failed (exit 23); this session will continue.", "warning",
	]]);
	assert.doesNotMatch(JSON.stringify(harness.notifications), /secret/);
});

test("reports an exec exception instead of swallowing it", async () => {
	const harness = createHarness({ throwExec: true });
	harness.handler({ reason: "startup" }, harness.context);
	assert.equal(harness.calls.length, 1);
	await flush();
	assert.equal(harness.notifications.length, 1);
	assert.equal(harness.notifications[0][1], "warning");
	assert.match(harness.notifications[0][0], /could not run/);
	assert.match(harness.notifications[0][0], /mock exec failure/);
});
