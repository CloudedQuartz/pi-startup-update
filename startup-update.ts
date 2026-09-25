import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function startupUpdate(pi: ExtensionAPI): void {
	// Synchronous handler: the update is fire-and-forget so Pi's startup does not wait.
	pi.on("session_start", (event, ctx) => {
		// Only fresh TUI startups; /reload, in-session switches, and non-TUI modes skip.
		if (event.reason !== "startup" || ctx.mode !== "tui") return;

		const cliEntry = process.argv[1];
		if (!cliEntry) {
			ctx.ui.notify("Pi startup update failed: process.argv[1] is missing.", "warning");
			return;
		}

		// A later session or /reload makes ctx stale; never use it after this handler returns.
		void pi.exec(process.execPath, [cliEntry, "update", "--all", "--no-approve"]).then(
			(result) => {
				if (result.code !== 0) console.error(`Pi startup update failed (exit ${result.code}).`);
			},
			(error) => console.error("Pi startup update could not run:", error),
		);
	});
}
