# pi-compactor

Configure automatic context compaction inside pi, with per-model, repository and session settings, a compact footer indicator, and a best-effort target for the **total context after compaction**.

Requires **pi 1.3.x** and **Node.js 22.19 or later**. Tested against pi 1.3.0. The interface and documentation are in English.

## Install

Copy this repository's HTTPS clone URL from GitHub and install it as a pi Git-source package:

```sh
pi install git:https://github.com/OWNER/REPOSITORY
```

Replace `OWNER/REPOSITORY` with this repository's owner and name, then restart pi or run `/reload`. No npm publication is required. A global installation is recommended because automatic-compaction ownership is a user-wide preference. pi's `--local` package installation is also supported, but the native automatic switch remains user-wide.

For development or a local checkout:

```sh
npm ci
pi -e ./src/index.ts
```

Loading the extension turns off pi's native automatic compaction and records its original global setting. Read [Uninstall and recovery](#uninstall-and-recovery) before removing the extension.

## Use

Run `/compactor` in the TUI. Choose **Configuration overview** to view all six levels together, or select **Trigger** / **Result target** for quick editing at that field's effective source.

The overview starts in read-only mode for the current model. It lists the saved trigger and target at every global/repository/session and all-model/single-model level. `—` means there is no override, `✓` marks each field's effective source, and `~` marks an overridden value. `!` marks a target/trigger conflict at that level; the effective result and any effective conflict are shown separately below the table. Built-in defaults and the fixed 20k minimum are also shown.

In the overview, use **↑/↓** to select a level and **←/→** to select a field. **E** explicitly opens that cell's editor, including when its value is inherited or overridden. **Ctrl+O** searches for another preview model using pi's native model selector. **Esc** returns to the main panel. Enter and navigation do not save changes. The selected cell also shows its exact saved value, and the snapshot note explains when external changes are loaded.

Inside a field editor:

- **Enter** applies a completed valid edit immediately. Use `20000`, `20k`, `1.5M`, or `80%`.
- **Ctrl+L** chooses global, current repository, or current session.
- **Ctrl+O** chooses all models or opens pi's native searchable model selector. Searching and model availability follow `/model`.
- **Ctrl+R** clears the selected override and restores inheritance. Submitting an empty value also clears it.
- **Esc** exits the current editor or panel. Already saved changes remain saved.

The editor labels the level, model scope, affected context, and any higher-priority override. Global and repository edits receive a warning color. Choosing another model only changes the settings being edited; it does not change the session's active model.

The panel also controls the global automatic switch and footer preferences. Commands are available for these lifecycle operations:

| Command | Behavior |
| --- | --- |
| `/compactor` | Open the settings panel in TUI mode |
| `/compactor off` / `on` | Persistently turn plugin automatic compaction off/on |
| `/compactor disable` | Disable the whole plugin; native automatic compaction stays off |
| `/compactor enable` | Explicitly enable the whole plugin again |
| `/compactor uninstall` | Remove the installed package and restore the original native setting |

Manual `/compact` keeps pi's native behavior, including when plugin automatic compaction is off. Saved automatic rules also apply in print/script and RPC modes; the panel and footer are TUI-only.

## Defaults and inheritance

Automatic compaction starts enabled, with an **80% trigger**, **20,000-token result target**, and a fixed **20,000-token minimum automatic trigger**. Both the configured trigger and fixed minimum must be reached.

Each of the trigger and result target inherits independently, from lowest to highest priority:

1. Global, all models.
2. Global, one provider/model ID.
3. Current repository, all models.
4. Current repository, one model.
5. Current session, all models.
6. Current session, one model.

Clearing an override exposes the next inherited value. The result target must be below the actual trigger, which is `max(20000, configured trigger in tokens)`. Invalid edits are rejected without saving or adjusting another field. If an existing configuration becomes invalid for a model, a request pauses when it reaches the trigger.

A saved threshold above model capacity is preserved and warned about. Models with context windows below 20k cannot automatically reach the fixed minimum; manual `/compact` remains available.

## What compaction does

Immediately before each session model request, including requests after tools finish, the extension checks context usage. Saving a setting never starts compaction itself.

When needed, it summarizes older conversation and budgets recent history against the total-context target, including the system context. Inseparable tool-call/result groups stay together; an oversized group may be included in the summary instead of retained verbatim. The checkpoint and compaction usage are saved in pi's session format, while the original history remains in the session file.

The result target is best effort. Provider usage is used when available; new or compacted context is estimated with pi's token estimator. Counts are not provider-exact. A result above the target may continue if it is below the trigger. Failed compaction, or a result still at the trigger, pauses the request and reports the error; there is no automatic compaction loop.

Compaction uses the request's selected model and credentials, so it can incur normal model usage costs.

## Footer

By default the footer shows `Compact at 80%`. Choose threshold/remaining and tokens/percentage independently:

| At threshold | Remaining capacity at the trigger |
| --- | --- |
| `Compact at 80%` | `Compact left 20%` |
| `Compact at 160k` | `Compact left 40k` |

“Left” is capacity remaining **at the trigger**, not a live countdown. Display preferences never change thresholds. Colors indicate proximity, red indicates reaching the trigger, and purple marks invalid or unreachable settings. Two built-in palettes are available. Automatic off shows `Compact off`; disabling footer display hides it.

## Persistence and multiple instances

Global/repository settings live in `compactor/settings.json` under pi's user configuration directory. Repository identities are hashed; no repository configuration is written into the worktree. Subdirectories and Git worktrees share settings. Outside Git, the startup working directory identifies the project.

Session overrides are custom session entries. Resume preserves them, `/new` starts without copied overrides, and `/fork` or `/clone` copies them independently.

Each instance reads a snapshot at startup or `/reload`. Its own edits immediately apply, while changes made by another instance wait until restart/reload. Writes merge individual fields on disk, use atomic replacement, and do not require configuration polling.

If configuration is corrupt, TUI mode offers an explicit reset without making a backup. Refusing disables the whole plugin until it is explicitly enabled. In non-interactive modes, corrupt configuration stops the model request and leaves the file untouched.

## Uninstall and recovery

Use **`/compactor uninstall`** from an installation made through `pi install`. It removes the package first, then restores pi's original global automatic-compaction setting. Run `/reload` afterward.

**pi 1.3.0 has no extension uninstall callback.** A direct `pi remove`, deleting the package, or disabling its resource in `pi config` cannot execute restoration code. Those paths leave native automatic compaction off. This is a host limitation; automatic restoration is supported through the plugin's uninstall command or the helper below.

From a retained checkout you can remove an installed package and restore the original setting:

```sh
node bin/manage.mjs uninstall 'git:https://github.com/OWNER/REPOSITORY'
```

If you already removed the package or stopped directly loading its extension path, restore the saved setting from a retained checkout:

```sh
node bin/manage.mjs restore-native
```

The helper also accepts `enable` or `disable`. Use `--agent-dir <path>` for a custom configuration directory, or set `PI_CODING_AGENT_DIR`. For a project-local package removed outside the panel, run `pi remove --local <installed-source>` and then `restore-native`. Restart/reload affected pi instances afterward.

The ownership record is `compactor/lifecycle.json`. Keep it until restoration: it records whether the original native switch was true, false, or absent. Do not delete it as a reset shortcut. If ownership metadata itself is corrupt, requests pause and the error is reported; repair that metadata rather than guessing the original native setting.

## Development

```sh
npm ci
npm run check
npm test
```

Tests exercise configuration inheritance, concurrent persistence, Git worktrees, native-compaction ownership, real SDK requests and tool continuations, failure handling (including with native retry enabled), manual compaction, reload, session copying, and corrupt-config recovery. Actual CLI tests cover RPC, local/Git-source installation, persistent deactivation, and uninstall restoration. They use temporary directories and fake/local providers, without sending paid model requests or touching your normal pi configuration.

GitHub Actions has verified type checking and the automated suite on macOS, Linux, and Windows with Node.js 22.19.0 and pi 1.3.0. Interactive TUI behavior has been checked on macOS; interactive Linux and Windows TUI sessions have not been manually exercised. The compatibility bridge is restricted to pi 1.3.x because its lifecycle integration uses exported SDK class methods beyond the ordinary ExtensionAPI. See [implementation notes](docs/implementation.md) and the [requirements](docs/requirements.md).

MIT licensed. See [LICENSE](LICENSE).
