import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { ExecResult, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { join, resolve } from "node:path";

const STATUS_KEY = "startup-update";
const PROCESS_CHECK_TIMEOUT_MS = 2_000;
const LOCK_CONFLICT_EXIT_CODE = 75;

function isOffline(): boolean {
	return /^(1|true|yes)$/i.test(process.env.PI_OFFLINE?.trim() ?? "");
}

function inspectPiProcesses(processes: string, currentEntry: string): { valid: boolean; otherPi: boolean } {
	let sawCurrentProcess = false;
	let otherPi = false;

	for (const line of processes.split(/\r?\n/)) {
		const match = /^\s*(\d+)\s+(\S+)(?:\s+(.*))?$/.exec(line);
		if (!match) continue;

		const pid = Number(match[1]);
		if (pid === process.pid) {
			sawCurrentProcess = true;
			continue;
		}

		const [, , command, args = ""] = match;
		if (command === "pi" || command === "pi-rpc") {
			otherPi = true;
		} else if (/^(node|nodejs|bun)$/i.test(command) && (
			args.includes(currentEntry) ||
			(args.includes("pi-coding-agent") && /(?:^|\s)\S*\/(?:dist\/)?(?:bundle\/)?cli\.js(?:\s|$)/.test(args))
		)) {
			otherPi = true;
		}
	}

	return { valid: sawCurrentProcess, otherPi };
}

export default function startupUpdate(pi: ExtensionAPI): void {
	let started = false;

	pi.on("session_start", async (event, ctx) => {
		if (
			started ||
			event.reason !== "startup" ||
			ctx.mode !== "tui" ||
			process.argv.length !== 2 ||
			isOffline() ||
			process.env.PI_SESSION_ID
		) {
			return;
		}

		const cliEntry = process.argv[1];
		if (!cliEntry) return;

		// Set before the first await so duplicate startup events cannot overlap.
		started = true;
		const cliPath = resolve(cliEntry);
		ctx.ui.setStatus(STATUS_KEY, "Checking for other Pi sessions…");

		try {
			let processCheck: ExecResult;
			try {
				processCheck = await pi.exec("ps", ["-eo", "pid=,comm=,args="], {
					timeout: PROCESS_CHECK_TIMEOUT_MS,
				});
			} catch {
				ctx.ui.notify("Startup update skipped: could not inspect running Pi sessions.", "warning");
				return;
			}

			if (processCheck.killed || processCheck.code !== 0) {
				ctx.ui.notify("Startup update skipped: could not inspect running Pi sessions.", "warning");
				return;
			}
			const processScan = inspectPiProcesses(processCheck.stdout, cliPath);
			if (!processScan.valid) {
				ctx.ui.notify("Startup update skipped: could not inspect running Pi sessions.", "warning");
				return;
			}
			if (processScan.otherPi) {
				ctx.ui.notify("Startup update skipped because another Pi session is active.", "info");
				return;
			}

			ctx.ui.setStatus(STATUS_KEY, "Updating Pi packages and core…");
			let result: ExecResult;
			try {
				result = await pi.exec("flock", [
					"-n",
					"-E",
					String(LOCK_CONFLICT_EXIT_CODE),
					join(getAgentDir(), ".startup-auto-update.lock"),
					process.execPath,
					cliPath,
					"update",
					"--all",
					"--no-approve",
				]);
			} catch {
				ctx.ui.notify("Pi startup update could not run; this session will continue without retrying.", "warning");
				return;
			}

			if (result.killed) {
				ctx.ui.notify("Pi startup update was interrupted; this session will continue without retrying.", "warning");
			} else if (result.code === LOCK_CONFLICT_EXIT_CODE) {
				ctx.ui.notify("Pi startup update returned exit 75 (lock conflict or updater status); this session will continue.", "warning");
			} else if (result.code !== 0) {
				ctx.ui.notify(`Pi startup update failed (exit ${result.code}); this session will continue.`, "warning");
			} else {
				ctx.ui.notify("Pi startup update completed; changes take effect on the next launch.", "info");
			}
		} finally {
			ctx.ui.setStatus(STATUS_KEY, undefined);
		}
	});
}
