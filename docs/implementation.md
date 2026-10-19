# Implementation notes

## Compatibility boundary

The ordinary pi 1.3.0 ExtensionAPI does not expose the active AgentSession, a native-auto-compaction setter, or an uninstall callback. The plugin loads through the official TypeScript extension system, but a small compatibility adapter in `src/host.ts` briefly wraps the exported `AgentSession.getActiveToolNames` method to associate the extension's session manager with its host session. pi calls this method after loading extensions during both startup and runtime rebuilding, so it also captures a session when the plugin is first installed during an already-running `/reload`.

The adapter supports pi 1.3.x and rejects other versions. It shares its mapping across extension reloads, reference-counts bootstrap wrappers, and restores the original method as soon as all pending instances capture their host, or when they shut down before capture. The SDK wrapper does no ongoing work after binding. Once associated, the plugin uses the SDK's `Agent.prepareRequest`, `SettingsManager.applyOverrides`, session projection/compaction APIs, and model registry. It does not edit installed pi code. SDK compatibility must be rechecked before extending the supported version range.

## Request and compaction behavior

The request gate chains an existing `prepareRequest` callback. It checks the session's projected context before every request, with the request's routed model. Recent provider-reported usage is reused when valid and later messages are estimated. Compaction/context-edit entries invalidate older usage. The summary budget and recent-history budget account for the current system context; they do not equate the result target with pi's `keepRecentTokens` setting.

The summarizer uses pi's model registry and credentials, writes a native compaction entry with usage, refreshes session context, and emits the extension `session_compact` event. A large indivisible tool group may be summarized with no recent messages retained. Failed or empty/truncated summaries leave the previous context intact. A completed checkpoint remains saved if its result still exceeds the trigger, and the next conversational request is paused. Detailed provider failures are reported separately from the paused request's generic error so pi's text-based retry classifier cannot automatically retry a failed compaction; normal model retry preferences remain unchanged.

Counts after compaction are heuristic. Tool/schema overhead and provider-specific formatting can make actual provider counts differ. The target therefore remains best effort. Context-modifying extensions and custom request callbacks should be tested together before relying on their combined behavior.

## Native ownership and uninstall limitation

Before taking ownership, the lifecycle record stores the original global `compaction.enabled` value (including its absence). Global native automatic compaction is persisted off, and an SDK runtime override also masks project-level values. The active plugin cancels native automatic compaction hooks while permitting manual compaction. Disabling the entire plugin removes its request gate and active listeners and leaves the persisted native switch off. A minimal startup path reapplies the mask after restart/reload and reads the enabled flag.

This satisfies deactivation without ongoing request interception. It cannot make a plain `pi remove` execute cleanup: pi 1.3.0 has no uninstall hook. The supported `/compactor uninstall` operation removes the package and then restores the saved native setting. The management helper supports removal/restoration and recovery after external removal. Standard host removal alone leaves native compaction off, which is a limitation against the original unconditional-uninstall requirement.

Global installation is recommended. Ownership is user-wide; installing multiple independent copies or mixing global/project copies is not a supported ownership arrangement. Project-local installation still disables the native global switch until restoration. Explicitly editing native compaction settings outside the plugin while it is wholly disabled is outside the plugin's enforcement path.

## Persistence

Persistent rules use a versioned JSON document under pi's agent directory. Repository keys hash the real Git common directory, or the real startup working directory outside Git. Writes merge only the edited field, use a lock and atomic rename, and restrict new directory/file permissions where supported. Existing instances retain their own snapshots.

Session overrides use `pi-compactor/settings` custom entries. Session-wide values follow the latest settings entry rather than the selected conversation branch. Fork/clone explicitly copies the source session's latest settings so a fork from an earlier message still gets the current session configuration. New/resume/fork runtime replacement carries the previous instance's global/repository snapshot; `/reload` reads a new one.

## Configuration overview

`src/overview.ts` builds the six applicable rows from the instance's loaded configuration and the preview model's provider/ID. Each cell retains its raw override and independently records inheritance, whether it supplies the final effective value, and any invalid target/trigger combination when resolving through that level. Intermediate conflicts remain visible even when a higher-level override repairs the final result.

The view is read-only until E explicitly opens the selected field editor at that row's scope. Cursor movement, Enter, model preview and rendering do not write settings. Model selection reuses pi's native selector and changes only the preview model. The table adapts its columns to terminal width and exposes the exact saved value for the selected cell.

## Verification scope

`npm run check` checks strict TypeScript types. `npm test` uses temporary configuration directories and a fake model provider with the actual pi SDK, including request preparation, tools, compaction persistence, native manual compaction, reload, corrupt-config handling, and new/resume/fork/clone snapshot behavior. Subprocess tests exercise the actual CLI RPC protocol against a local HTTP fixture, local package installation, and Git-source installation with a locally rewritten remote. They verify persistent deactivation across processes and native-setting restoration through plugin uninstall. GitHub Actions has passed these checks on macOS, Linux, and Windows with Node.js 22.19.0 and pi 1.3.0.

Actual CLI TUI checks use an isolated agent directory and a loopback dummy model. They cover first installation into an already-running session followed by `/reload`, loading, editing, immediate persistence, native searchable model selection, read-only overview navigation and explicit scope-specific editing, provider-separated previews, repeated reloads, narrow terminal resizing and Escape behavior without making model requests. These interactive checks were performed on macOS; interactive Linux and Windows TUI sessions have not been manually exercised.

The source requirements remain unchanged. This document records implementation mechanics and the host's uninstall limitation rather than silently weakening those requirements.
