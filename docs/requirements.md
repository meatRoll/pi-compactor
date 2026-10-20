# pi-compactor requirements

This document defines the functional requirements and acceptance criteria for pi-compactor.

## Purpose

Configure automatic context compaction directly inside the pi TUI. Users should not need to locate configuration files or edit many low-level parameters. Favor a small number of settings and few interaction steps.

Publish the project as a public GitHub repository. Use pi's official extension system. Use English for the configuration UI, status text, README, installation instructions, and usage documentation. Use the MIT license. The initial compatibility and acceptance baseline is pi 1.3.0; older versions are not required for the first release. Design one extension for the platforms supported by pi.

## Distribution and first delivery

The first delivery includes a locally usable plugin, appropriate passing checks/tests, complete English installation and usage documentation, the MIT license, and publication through a public GitHub repository.

Support installation through pi's standard Git-source package mechanism. Do not require npm publication or any other distribution channel.

## Core settings and defaults

| Setting | Default | Scope |
| --- | --- | --- |
| Automatic compaction | Enabled | One persistent global switch |
| Compaction trigger | 80% of the active model's context capacity | Six configuration levels described below |
| Compacted context target | 20,000 tokens | Same six levels, inherited independently |
| Minimum automatic trigger | 20,000 tokens | Fixed internal constant; never user configurable |
| Footer status | Enabled | Global display preference |
| Footer basis | At threshold | Global display preference |
| Footer unit | Percentage | Global display preference |
| Footer colors | Built-in scheme | Global display preference |

A user-configured trigger or result target may use an absolute token count or a percentage of the model's context capacity. The fixed minimum trigger is always an absolute token count.

The compacted context target covers the total context after compaction, including the summary and retained recent conversation. It is not merely the summary size or the amount of recent conversation retained verbatim. It is a best-effort target, not a strict output ceiling.

## Configuration levels and inheritance

Resolve each configurable field independently, in this order from lowest to highest priority:

1. Global, all models.
2. Global, one model.
3. Current repository, all models.
4. Current repository, one model.
5. Current session, all models.
6. Current session, one model.

The built-in defaults are below all six levels. In particular, repository-wide settings override global model-specific settings; session-wide settings override repository model-specific settings.

Allow clearing an override to inherit the next available value. Clearing all applicable overrides uses the plugin's built-in defaults, never pi's existing automatic-compaction settings.

The trigger and result target can have different sources. For example, a repository trigger of 70% can inherit a global result target of 30k.

The automatic-compaction switch is global and does not participate in this hierarchy. Display preferences are also global and do not participate in it.

## Repository, model, and session identity

- Git subdirectories share their repository's configuration.
- All worktrees belonging to the same Git repository share repository-level configuration.
- Outside Git, the pi startup working directory identifies the project scope.
- Repository settings are personal preferences, stored under the pi user configuration directory and keyed by repository identity. They are not intended to be committed to Git or shared with a team.
- A model is identified by its provider and model ID together. Identically named models from different providers have separate configuration.
- Session settings persist with the session and remain effective when that session is resumed.
- A normal `/new` session starts without copied session overrides and inherits repository/global configuration.
- `/fork` and `/clone` copy the source session's session-level configuration. The source and copy are independent afterward.

## TUI configuration

Open the English configuration panel with `/compactor`.

- Initially select Trigger at its effective source in the configuration overview, rather than a fixed global/repository/session scope. If it uses built-in defaults, select global/all models. The user may explicitly select another level and field; E opens the editor at that exact selected scope.
- Show the effective trigger, effective result target, and their configuration sources.
- During editing, clearly display the selected level, all-model/single-model scope, and affected context. Make edits to inherited global or repository settings visibly distinguishable from session-local edits, so users do not accidentally change an upper-level setting. A source change must remain visible when switching fields or scopes; immediate saving still applies without adding a separate Save step.
- Show when the selected override is masked by a higher-priority value.
- Allow managing global settings, the current repository, and the current session. Do not add a browser for other repositories or historical sessions in the first release.
- When selecting a single model, initially select the current model and allow choosing another model.
- Model selection must support search with the same experience as pi's `/model` search.
- Save a completed, valid edit immediately. Do not require a separate Save action.
- Esc closes the panel and retains changes already saved.
- Reject an invalid edit with an error instead of saving it or silently correcting it.
- A newly saved trigger does not immediately start compaction. It is used by the next pre-request check.

Each field editor uses the explicitly selected overview cell's scope. Keep the editable scope visible throughout the interaction.

Provide a read-only **Configuration overview** from the main panel:

- Show all six levels together for the preview model, with independently displayed saved trigger and result-target overrides. Show unset values as inherited, rather than filling them with effective values.
- Mark each field's effective source and distinguish overridden values. Identify target/trigger conflicts at individual levels and separately report any conflict in the final effective result.
- Show the final trigger (including the fixed minimum), final target, their sources, and the built-in defaults. Show the exact saved value for the selected cell.
- Start with the current model and allow native model search to choose another preview model without changing the session's active model.
- Use up/down to select a level, left/right to select a field, and E to explicitly edit that cell at its selected scope. Viewing, navigation and Enter do not save settings. Esc returns to the main panel.
- Use the overview as the single entry for editing trigger and result-target settings; omit separate main-panel field shortcuts. Remember the selected row and field when returning to the overview during the same panel interaction. A new `/compactor` interaction initially selects Trigger at its effective source. Display that the overview uses the instance's loaded snapshot and external edits require restart/reload.

## Instance loading and refresh

Each running pi instance uses the configuration snapshot read at its startup or most recent `/reload`.

Changes saved through an instance's own panel immediately update that instance's configuration snapshot. Other already-running instances continue using their existing snapshots. They read external changes only after restarting or reloading, not before each model request.

Switching models or sessions selects the applicable values from the instance's loaded configuration; it must not incidentally synchronize other instances' edits.

Session lifecycle operations must still load or restore the selected session's own persisted overrides.

## Automatic-compaction ownership and checks

While installed, the plugin owns automatic-compaction rules and ignores pi's existing automatic trigger configuration, including when no plugin override matches. Turning off the plugin's automatic switch or disabling the entire plugin must keep native automatic compaction disabled. Only uninstalling the plugin restores pi's native automatic-compaction behavior.

Check before every model request, including follow-up requests after tools complete within a long-running task. Do not restrict checking to new user messages.

Automatic compaction requires both:

- Context at or above the fixed 20,000-token minimum.
- Context at or above the effective user trigger, or the plugin's default 80% trigger when no override applies.

Equivalently, the actual automatic trigger point is the greater of the fixed minimum and the resolved configured trigger in tokens. This does not rewrite the user's saved setting.

When automatic compaction is switched off, no automatic compaction runs, including pi's native automatic compaction. The switch persists across restarts.

Preserve pi's existing manual `/compact` behavior. The automatic switch does not disable manual compaction. The fixed automatic minimum does not prevent manual compaction.

## Validation and compaction outcomes

The result target must be below the actual automatic trigger point.

- Reject a configuration edit that produces an invalid target/trigger combination.
- Do not silently adjust the trigger or result target.
- If a bad combination already exists, for example after model switching or inherited configuration changes, report it and pause the model request when its trigger is reached. Require the user to fix it.
- If automatic compaction fails, pause the model request and report the error. The user decides whether to retry.
- If compaction succeeds but the resulting context is still at or above the automatic trigger point, pause and notify the user. Do not repeatedly compact in a loop.
- If the resulting context is below the trigger point, allow the request to proceed even if the best-effort target was exceeded. Report the actual result.

For example, with a 30k trigger and 20k target, a result of 22k may proceed, while a result of 32k must pause and notify.

## Thresholds outside model capacity

Honor a saved trigger even when it exceeds the current model's context capacity. Do not clamp it or substitute the default 80% trigger. Such a trigger may be unreachable within that model's capacity.

Check and warn at session start, session switching, and model switching. If footer status is enabled, mark the condition with an abnormal color distinct from normal proximity colors.

A fixed 20k minimum also means models with context capacity below 20k cannot automatically compact within their capacity. Show a warning for this limitation. Manual `/compact` remains available.

## Footer status

Show only the currently effective compaction trigger, not its configuration source. Sources belong in the panel.

Provide two independent display choices:

- At threshold or remaining threshold.
- Token count or percentage.

These are display choices and must never change the actual compaction settings. The remaining form describes the context capacity remaining at the trigger point, not a live countdown from the current usage.

Use these short English forms:

| Basis | Unit | Example |
| --- | --- | --- |
| At threshold | Percentage | `Compact at 80%` |
| At threshold | Tokens | `Compact at 160k` |
| Remaining threshold | Percentage | `Compact left 20%` |
| Remaining threshold | Tokens | `Compact left 40k` |

Do not append `tokens` or use the longer `with ... left` wording.

Update the effective value when the active model, session, or applicable configuration changes within the loaded snapshot.

When automatic compaction is off but footer display is on, show `Compact off`. Turning footer display off hides the whole item.

Provide built-in color schemes and several proximity bands, such as green, yellow, and orange. Display red when the current context reaches the trigger. Use a distinct abnormal color for an invalid or unreachable configuration. Do not expose free-form editing of each color or band boundary. Exact built-in band boundaries are an implementation detail.

Display visibility, basis, unit, and scheme are persistent global preferences.

## Corrupt configuration and whole-plugin deactivation

In TUI mode, if configuration cannot be parsed at startup or reload, ask whether to reset it to plugin defaults.

- Reset only with the user's consent.
- Do not automatically back up the damaged file. Backups are the user's responsibility.
- If the user refuses, put the entire plugin into the disabled state and notify the user.
- After that notification, the user decides how to continue. The plugin must not keep running partially, continue intercepting requests, or substitute a `Compact error` status for actual deactivation.
- The plugin stays disabled until the user explicitly re-enables it. Restarting or reloading must not automatically reactivate it.

In a non-interactive mode, configuration corruption returns a configuration error and stops the current model request. Do not ask an interactive question or modify/reset the file. The caller decides what to do next.

Whole-plugin deactivation is distinct from switching off automatic compaction in an otherwise active plugin. Both states keep pi's native automatic compaction disabled. The disabled plugin must perform no ongoing work; implementation must therefore preserve the native-disabled state without relying on active plugin handlers. Only uninstalling the plugin restores pi's native automatic-compaction behavior. Verify this across restart and reload as well as within the current process.

## Execution modes

Apply saved automatic-compaction rules in all pi modes, including TUI, non-interactive/script use, and RPC. The custom panel and footer exist only in the TUI. Report failures through the appropriate mode's error mechanism.

## Investigation notes

The following facts were checked against the pi 1.3.0 documentation and exported APIs:

- Default `reserveTokens` is 16,384; this is not an absolute minimum trigger.
- Default `keepRecentTokens` is 20,000; this is the recent verbatim-history budget, not a post-compaction total-context target.
- The native `shouldCompact` condition is `contextTokens > contextWindow - reserveTokens`, with the automatic-enabled flag honored.
- The native predicate has no independent fixed minimum trigger. Public API checks confirmed this for small context windows.
- The plugin's fixed 20,000-token minimum is a product decision, not a pi native default.
- The plugin's 20,000-token total-context target borrows a familiar numeric value but has different semantics from `keepRecentTokens`. Simply setting that native field does not implement the agreed target.

Use the host's available context accounting and model-capacity metadata when implementing these behaviors. Do not claim provider-exact token counts from heuristic estimates.

## Acceptance scenarios

1. Open `/compactor`, find the active settings and their sources, and complete a valid edit without a separate Save action. When fields have different sources, the overview marks each source independently; each editor uses the selected cell's scope and clearly shows the editing level, model scope, and affected context.
2. Search for a model with `/model`-equivalent behavior, including separate entries for the same model ID from different providers.
3. Apply the six precedence levels in the agreed order; in particular, a repository-wide value overrides a global model-specific value.
4. Override only the trigger and inherit the result target independently; clear an override and recover the next inherited value.
5. Resume a session and retain its overrides; `/new` inherits normally; `/fork` and `/clone` copy overrides independently.
6. Use one repository configuration from its subdirectories and from all its worktrees.
7. Save in one instance; another instance retains its old snapshot until restart or `/reload`.
8. Default to automatic compaction on, 80% trigger, 20k result target, and the fixed 20k minimum.
9. Check before user-initiated and tool-follow-up model requests, without initiating compaction merely by editing a setting.
10. Reject invalid target/trigger edits; pause for an existing conflict when reached, for compaction failure, or for a post-compaction result still at the trigger.
11. Preserve oversized thresholds and warn at the agreed lifecycle events instead of substituting a default.
12. Show all four short footer formats without altering compaction behavior; reflect off and abnormal states correctly.
13. Keep manual `/compact` usable with automatic compaction off. Disabling the entire plugin must also leave native automatic compaction disabled, including after restart or reload; uninstalling the plugin restores native automatic compaction.
14. Recover a corrupt config only with consent; if refused, disable the entire plugin until explicitly re-enabled. In non-interactive mode, report the error and stop the request.
15. Apply the same automatic rules through TUI, script/non-interactive, and RPC execution.
16. Install from the public GitHub repository using pi's standard Git-source package support, with English instructions and the MIT license; no npm package is required.

## Implementation checks

Verify that pi 1.3.0 can support the agreed lifecycle without an active disabled plugin: native automatic compaction remains off while installed, including after restart/reload, and uninstalling restores native behavior. Preserve the distinct manual-compaction behavior.

Implementation mechanics such as filenames, serialization layout, safe file writes, library choices, and exact built-in color boundaries should be resolved during development, rather than adding more user-facing settings.
