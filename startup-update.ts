import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function startupUpdate(pi: ExtensionAPI): void {
	pi.on("session_start", async (event, ctx) => {
		// Only fresh TUI startups; /reload, in-session switches, and non-TUI modes skip.
		if (event.reason !== "startup" || ctx.mode !== "tui") return;

		const cliEntry = process.argv[1];
		if (!cliEntry) {
			ctx.ui.notify("Pi startup update failed: process.argv[1] is missing.", "warning");
			return;
		}

		try {
			const result = await pi.exec(process.execPath, [cliEntry, "update", "--all", "--no-approve"]);
			if (result.code === 0) {
				ctx.ui.notify("Pi startup update completed; changes take effect on the next launch.", "info");
			} else {
				ctx.ui.notify(`Pi startup update failed (exit ${result.code}); this session will continue.`, "warning");
			}
		} catch (error) {
			ctx.ui.notify(`Pi startup update could not run: ${String(error)}`, "warning");
		}
	});
}
