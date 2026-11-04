# TRAE queue status

TRAE queue status adds a `TraeX` provider to Paseo. It runs TRAE CLI in ACP mode
with the experimental headless queue-status feature and renders backend model queue state as one
updating timeline card. When TRAE CLI advertises steering support, another message can be injected
into the active turn without canceling a queued or running request.

The daemon user must have TRAE CLI installed, authenticated, and available through `PATH`. The
provider exposes the models reported by that TRAE CLI installation, so each user selects a model
available to their account.

Each new turn ends with a usage row: `本轮:`, model calls, tool calls, then a token icon and
compact total from that native session's local records. Hover over or keyboard-focus the token
group to see input, cache reads, cache creation, output, reasoning, and total tokens; touch clients
can tap it for the same details. The desktop tooltip avoids scroll clipping and viewport edges,
and closes on Escape, scrolling, or resizing. Activity counts stay directly visible.
Input, output, and reasoning percentages use total tokens; cache percentages use input tokens.
Percentages use one decimal place, with a zero denominator marked unavailable. Missing details
and fields absent from historical rows remain unavailable, rather than zero or partial sums.
The row stays on one line; narrow layouts scroll horizontally to show the complete statistics.
Client text, SVG icons, inputs, and open detail surfaces update with Paseo's light and dark themes.
From 0.5.1, the brain icon counts native model requests, including those without visible Thinking text.
Tool counts include outer `exec` calls and nested dispatches, matching the platform trace definition.
Status updates and resumed code cells count once; failed and canceled calls are included.
Counts require native trace schema 1 (checked with TRAE CLI 0.214.1-alpha.2). Missing traces show
unavailable, while known call counts remain visible even if token records cannot be read.
Old Thinking/ACP counts are not shown as platform statistics or backfilled. Native tracing uses
a private temporary directory; raw payload files are discarded every second, and the directory
is removed when the connection closes. Only counting IDs are retained in memory and counts are
sent to the client, without an additional trace upload. An existing `TRAECLI_ROLLOUT_TRACE_ROOT`
is respected and its files are preserved.
Tool follow-ups and steering belong to the same turn;
separate subagent sessions are excluded. Cached input and reasoning are not counted twice.
The row retries delayed writes for up to five seconds and shows unavailable when records cannot
be read reliably. Failed and stopped turns retain their recorded usage. Imported historical
replies are not backfilled.

A database icon and compact total beside Tasks / Subagents show the conversation's lifetime
input-plus-output tokens, including restored history and requests across model switches. Click
for a popover showing input, cache reads, cache creation, output, reasoning, and their percentages.
Cache shares use input as the denominator; other shares use the total. Cache and reasoning are
already included in input and output. Missing historical details remain unavailable. On compact
layouts the popover opens as a bottom sheet. While visible, usage refreshes every five seconds;
the pill, tooltip, and popover share the same compact number format. This total excludes independent
subagent sessions and is read locally without prompting a model.

Turn and session detail popovers include estimated USD cost, such as `728.41K | $50.2`, while
their timeline and composer labels show token counts only. Daily and weekly costs remain in the model status panel.
Opening a turn detail retries unknown costs from the original request records, including existing
rows created before prices became available. Older rows must match one native turn unambiguously.
Both values use the same compact number format. Costs use Models.dev's current standard prices,
calculated per request for ordinary input, cache reads, cache creation and output, including
request-level context tiers. They do not represent TRAE invoices or account discounts.
Absent DeepSeek cache-write rates fall back to its ordinary cache-miss input price, and TRAE's
V4.1 Flash name resolves to the official `deepseek-flash` entry. Missing prices or billing details
show `$—` without hiding token counts or presenting partial costs as totals.
The daemon downloads the public catalog from `https://models.dev/api.json`, without sending
credentials, conversation content or usage. Prices are cached for 24 hours and persisted under
`$XDG_CACHE_HOME/paseo-trae-queue-status` (default root: `~/.cache`). Expired prices refresh on the
next query; a failed refresh retains the last successful catalog and retries after five minutes.

Paseo 0.13.0 or later is required on both the daemon and connected app, with Node.js 20.19.0 or
later on the daemon. Open **TraeX 模型状态**
from the top of the main sidebar, workspace panels, Explorer, or Command Center to compare model loads and weekly quotas.
Model menus also show the weekly remaining percentages. Model choices and capabilities come from
TRAE CLI's native responses.
The **问题反馈** (Feedback) button at the top of the panel opens GitHub Issues for questions and suggestions.
Each model also shows today's and this week's tokens, calculated as input plus output including
cached input, with Standard and Max combined. Below each total, a second line shows cached input,
new tokens (total minus cached input), and the cached share of total usage; missing cache data is marked unavailable.
Counts use compact K, M, B and larger units with up
to two decimal places, and can be sorted by daily or weekly usage using the original
token counts. Days start at midnight and weeks at Monday midnight
in the displayed daemon time zone. Usage reads local TRAE CLI session and archive records,
including subagents. It includes accounts previously used on this host, excludes deleted records
and other devices, and respects `TRAE_HOME` and `TRAECLI_HOME`. It is not an account billing total.
Unsorted column headers show ↑↓; the sorted column shows ↑ or ↓. Click a header to toggle the order. Narrow screens can scroll
horizontally. Search, filters, and sorting are saved
independently in each tab and restored after app reloads.
The panel shares the provider's 30-second query cache, shows when data was last updated, and
retains the last successful result with a warning if refresh fails. Missing metrics remain unknown.
Use the session's model menu to select a model; the panel's CLI catalog may include unavailable models.

Once a session opens, the composer's Context selector offers Standard and Max for models that
support Max. Context changes keep compatible thinking levels, and models without Max use Standard.
Restored sessions retain their native context selection.
At startup, an inherited Max setting uses Standard when the selected model's native variants do
not support Max, so saved settings do not block a first message to a model without Max support.

The composer prefers TRAE CLI's native Collaboration mode selector and hides the plugin's legacy
Plan toggle when it is available. Saved Plan settings map to the native selector, with explicit
collaboration settings taking precedence. Permissions remain independent. Restored legacy read-only
Plan sessions migrate to native Plan before saved configuration is applied; failed migration restores
the read-only permission and reports an error. Older CLIs retain the separate Plan toggle and its
permission-restoration behavior. Only one planning control is shown.

Open **导入 TraeX 会话** from the destination workspace's panels, Explorer or Command Center to
resume a saved conversation from any original directory. The panel displays its destination and
keeps the workspace ID attached to listing and import. Closing a conversation in A and importing
it from this panel in B places it in B, preserving the native session ID and history while A's old
card stays archived. Search, refresh and loading more sessions are available. Paseo's built-in
**Import session → This workspace** filters by the original directory, recognizing symlink aliases;
**Show all** includes other directories and uses each conversation's original directory.
The plugin import panel hides conversations already open in any Paseo workspace, and rejects
duplicate or concurrent imports by native session ID. If another TRAE CLI client holds the session,
the import error asks you to close the original conversation before retrying.
Search preserves input focus and filters loaded results immediately while querying further matches.
Loading stays inline; refresh shows progress and update time, and failed refreshes retain the list.

The plugin's AskUserQuestion tool shows Paseo's question card in Default, Full Access and Plan
modes. Choose options or enter a custom answer, then continue the waiting TRAE task. Dismissing
the card or stopping the turn cancels the question. Default and Full Access were verified with
TRAE CLI 0.210.1-alpha.3. Start a new session or reconnect after updating.
The tool uses a local loopback MCP service with random per-session addresses and is allowed
automatically without changing the session's permission mode. Native blocking ACP forms are
also supported; native GPT non-blocking questions are not forwarded by this TRAE ACP version.

Agent prompts, conversation messages, and tool results are sent through TRAE CLI to the
services configured for the user's TRAE account. Workspace content read by the agent may be included
in those requests. TRAE CLI uses its existing authentication and provider configuration; running
the plugin locally does not keep agent conversations on the daemon host. The model-pricing request
described above is separate and sends no conversation content or credentials to Models.dev.

The daemon-side provider starts and stops local TRAE CLI child processes and reads their ACP
JSON-RPC stream. A cross-platform client renderer keeps one row per queue cycle, discards repeated
identical updates, and updates the row when the backend position changes. The plugin sends no queue
data to an additional service. Its server code is trusted and unsandboxed. Queue status and
`_session/steering` remain experimental TRAE CLI contracts, so the plugin gates steering on the
capability reported during ACP initialization.

Native TRAE subagents appear in Paseo's Subagents entry with read-only child timelines and independent
background status. On parent restore, the plugin rebuilds the child list and reads final results
from linked local rollouts; complete historical child transcripts are not available through current
TRAE ACP. This requires subagent metadata, verified with CLI 0.214.1-alpha.2.
