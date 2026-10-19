import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { report } from "./compaction.ts";
import { asError, Compactor } from "./controller.ts";
import { openPanel } from "./panel.ts";

export default function compactor(pi: ExtensionAPI): void {
  const controller = new Compactor(pi);
  pi.registerCommand("compactor", {
    description: "Configure automatic compaction, thresholds and footer; enable, disable or uninstall the plugin",
    getArgumentCompletions: prefix => ["on", "off", "enable", "disable", "uninstall"].filter(value => value.startsWith(prefix)).map(value => ({ value, label: value })),
    handler: async (args, ctx) => {
      try {
        const action = args.trim();
        if (action === "enable") { await controller.enable(ctx); report(ctx, controller.active ? "Compactor enabled." : "Compactor remains disabled."); }
        else if (action === "disable") { await controller.disable(); report(ctx, "Compactor disabled until explicitly enabled. Native automatic compaction remains off."); }
        else if (action === "uninstall") await controller.uninstall(ctx);
        else if (action === "on" || action === "off") {
          if (!controller.active) throw new Error("Compactor is disabled. Run /compactor enable first.");
          await controller.automatic(action === "on");
          report(ctx, `Automatic compaction ${action}.`);
        } else if (!action) await openPanel(controller, ctx);
        else throw new Error("Usage: /compactor [on|off|enable|disable|uninstall]");
      } catch (error) { report(ctx, asError(error).message, "error"); }
    },
  });
  pi.on("session_start", (event, ctx) => controller.start(event, ctx));
  pi.on("session_shutdown", event => controller.shutdown(event.reason));
}
