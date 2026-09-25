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

		// Completion is not guaranteed if Pi exits before the updater finishes.
		void pi
			.exec(process.execPath, [cliEntry, "update", "--all", "--no-approve"])
			.then((result) => {
				if (result.code === 0) {
					ctx.ui.notify("Pi startup update completed; changes take effect on the next launch.", "info");
				} else {
					ctx.ui.notify(`Pi startup update failed (exit ${result.code}); this session will continue.`, "warning");
				}
			})
			.catch((error) => {
				ctx.ui.notify(`Pi startup update could not run: ${String(error)}`, "warning");
			});
	});
}
