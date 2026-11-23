# Cache Keeper

A strip above Claude Code's prompt box that shows when the prompt cache goes cold and what that costs. It works on its own:

- **The strip** counts down to the moment the cache goes cold. Beside the countdown: what the next message costs, the context size, the account's 5-hour and weekly limits, and what the session has cost.
- **A warning** comes 5 minutes before the cache goes cold: a desktop notification and a toast in Claude Code.
- **Handoff & Clear**, the strip's button, asks Claude for a handoff brief, runs `/clear`, and puts the brief in the fresh session's prompt.
- **The cold-send guard** holds a message typed into a big session whose cache has gone cold, and says what sending it would cost. It does the same for an answer to Claude's question.

Two more ways on once the cache is cold, Use Latest Handoff and Pack & Clear, need [companion tools](#companions).

```
● cache 45:00 →15:00 1h · next msg $0.08, cold $3.20 · ctx 400k/1M · 5h 25% ↻17:00 · wk 50% ↻Mon · Fable 80% · session $12.50 API   [ Handoff & Clear ]
```

| Segment | What it is | Where it comes from |
|---|---|---|
| `● cache 45:00` | Time until the main thread's prompt cache goes cold. Green while warm, yellow in the warning window, `○ cache cold` after. | Claude Code's own cache tracker (`prompt_cache` in the status line input). |
| `→15:00 1h` | Wall-clock expiry and the cache window. | The TTL Claude Code measured from the last write: `ephemeral_1h_input_tokens` versus `_5m_`. |
| `next msg $0.08, cold $3.20` | Input cost of the next message while warm (cache read), and once cold (the whole prefix written again). Output tokens are the same either way and are left out. | `recache_tokens_if_cold` × the model's rate. |
| `ctx 400k/1M` | Current context size and the window. | `context_window` |
| `5h 25% ↻17:00` | The account's 5-hour usage limit and when it resets. | The newest reading any session has: a response's rate-limit headers, or the usage endpoint behind `/usage` (see [Account limits](#account-limits-live-in-every-session)). |
| `wk 50% ↻Mon` | The account's weekly limit and its reset day. | The same. |
| `Fable 80%` | A model's own weekly limit, where the account has one. | The usage endpoint only (`limits[]`, kind `weekly_scoped`): no response header carries it. |
| `session $12.50 API` | What this session would have cost on API billing. | `cost.total_cost_usd`: Claude Code's own figure, subagents included. |

A narrow terminal drops the details first, then the lower-priority facts. The countdown always stays.

When the cache window cannot be measured, the window falls back to 60 minutes and is drawn with a `?` (`60m?`). That happens in a session resumed from an old transcript, where the transcript's last request is used instead. Change the fallback, or force a window, with `/cache-keeper`.

## Before you install

- **Mods on.** The strip, its buttons and the guard are function hooks, run by a hooks module. Function hooks are early access, and their API moves between releases: Cache Keeper was built on Claude Code 2.1.280 and last tested on 2.1.322. Where mods are off, the status line alone still shows everything and still warns. The buttons and the guard need the strip.
- **A terminal session.** The strip and its buttons are drawn in a terminal only.
- **Node.js on PATH**, for the status line, which runs `node`. The strip itself runs inside Claude Code.
- **The status line replaces yours.** Claude Code runs one status line command. Setting Cache Keeper's in place of the one you have is optional: without it the strip still runs, and reads the cache window from the transcript (drawn with a `?`).
- **Windows paths in JSON.** In `settings.json`, write a Windows path with `/` (`C:/Users/<you>/...`) or with doubled backslashes (`C:\\Users\\<you>\\...`). JSON reads a single `\` as an escape.

## Install

At the prompt of a Claude Code terminal session:

```
/plugin install cache-keeper --marketplace gjovanov/cache-keeper
```

Answer `y` to add the marketplace, then press Enter for the user scope. From a shell:

```sh
claude plugin install cache-keeper --marketplace gjovanov/cache-keeper
```

In the desktop app, where `/plugin` does not run: click + next to the prompt box, then Plugins, Add marketplace with `gjovanov/cache-keeper`, then Add plugin.

Then the status line, in `~/.claude/settings.json`. The countdown is exact when Cache Keeper's script is the status line, because Claude Code hands its own cache tracker to the status line command:

```json
"statusLine": { "type": "command", "command": "node \"<home>/.claude/plugins/marketplaces/cache-keeper/bin/statusline.mjs\"", "refreshInterval": 30 }
```

`<home>` is your home folder.

## The warning

When the cache is 5 minutes from going cold, Cache Keeper sends a desktop notification and a toast in Claude Code, once per expiry and per session. Each one names the session and the price of letting it go cold. Send any message to keep the cache warm, or press the button.

On Windows the notification is a toast. To show it, Cache Keeper starts Windows PowerShell with a hidden window: `powershell.exe -NoProfile -NonInteractive -WindowStyle Hidden -Command <script>`. The script is one fixed, inline WinRT call, written in `hooks/core.mjs`: no script file, no encoded command. The title and text travel in its environment, never in the code it runs. The toast shows under Windows PowerShell's own app id. Endpoint security software can flag a hidden PowerShell started this way. On macOS the notification uses `osascript`, on Linux `notify-send`.

`/cache-keeper notify off` turns the warning off: the desktop notification and the toast in Claude Code alike. It is saved as `"notify": false` in `~/.claude/cache-keeper/config.json`. `/cache-keeper warn 0` does the same.

## Account limits, live in every session

The 5-hour and weekly limits belong to the account, but Claude Code learns them only from the rate-limit headers on a session's own responses. A session that sends nothing keeps showing the figures of its last request, while the other sessions, claude.ai and other machines go on spending the same allowance. Cache Keeper puts one reading in `~/.claude/cache-keeper/limits.json` for every session, and the strip shows that reading when it is newer than the session's own:

- **Every response.** When a response in any session moves a window by a whole point (`session.measure`), that session writes the new figures. Every other strip shows them within two seconds. A response's headers leave the server when its request starts, so after a long turn they can trail what another session or the endpoint has read since. Within one window the higher figure stands, so the strip never steps back. A reading from a window that has already ended is dropped.
- **The usage endpoint, once a minute.** One session asks `https://api.anthropic.com/api/oauth/usage`, the endpoint `/usage` reads, which also counts what claude.ai and other machines used. Only it reports a model's own weekly limit (`Fable 80%`), so that figure is shown while the endpoint's last answer is under 30 minutes old. A claim in the file keeps a second session from asking at the same time. A per-session offset of up to 15 seconds means the same session usually does it. A failure (an HTTP error, no network) backs every session off together, doubling from a minute up to 30 minutes.
- **One login's reading, in that login's sessions.** Two logins can share one config dir: `/login` replaces the token on disk, but an idle session keeps the old one until it next sends, and its poll answers for the old login. The weekly window tells them apart. A session whose own week is still running shows only a reading from that same week, and `/cache-keeper` says when the file holds another login's. A model's own limit stands only beside the week it was read in. A week that was re-anchored reads the same way as another login's, so an idle session keeps its own figures until it next sends.
- **The credential stays in Claude Code.** The module asks `$.session.authorize()` for an opaque handle and passes it to `$.http.fetch`. Claude Code sets the header itself, and only on an `https` request to its own API host. Only a claude.ai login (a bearer) polls; a session with an API key does not.

The usage poll is on by default. It makes the same request `/usage` makes. It asks at most once a minute on a machine: one session asks for every session that shares the config folder, and a failure backs them all off together. That endpoint's rate limit counts per login: when it is hit, `/usage` also shows "rate limited" for a while.

`/cache-keeper limits off` turns the poll off. It is saved as `"limitsPollSeconds": 0` in `config.json`. The strips then share only what responses report. `/cache-keeper limits <seconds>` sets another interval, from 15 to 3600 seconds.

`/cache-keeper` says where the figures came from and how old they are. A reading older than 30 minutes stands down, and each strip shows its own session's again.

## Handoff & Clear

One press:

1. **Asks for a brief.** Claude writes a handoff brief in a fork of the session: one tool-less question over the transcript, served from the warm cache. Nothing is added to the transcript.
2. **Saves it** to `~/.claude/cache-keeper/handoffs/`.
3. **Runs `/clear`.**
4. **Pastes the brief** into the fresh session's prompt box. Press Enter to send it, or add instructions first. Anything you had typed is kept after the brief.

Pressed while Claude is working, it queues and runs when the turn ends. If the reply holds no brief, nothing is cleared. The old session is still there under `/resume`. From the keyboard, `/cache-keeper handoff` does the same, and `ctrl+x tab` then Enter presses the button. It is not `/handoff`: a skill of that name, common in skill collections, takes the bare name, and Claude Code then runs the skill instead.

The buttons stay on screen when the band above the prompt has no row for the strip. That happens in fullscreen, where Claude Code's task list takes the space above the prompt while Claude is idle (in a 27-row terminal, five tasks leave the band none), and while the band is collapsed or holds a survey. The buttons are then drawn under the prompt, at the right end of its footer, dim while Claude works as in the strip, and they go back up once the band has a row. They are never in both places. Under the prompt a click presses them, but `ctrl+x tab` reaches only the band: use the typed commands there. With five tasks they show down to a 24-row terminal; below that, Claude Code draws no row under the prompt at all.

Once the cache is cold, the brief is expensive: the fork that writes it sends the whole conversation again at the cache-write price, about the strip's `next msg` figure. The cold strip still offers Handoff & Clear:

```
○ cache cold since 15:00 · next msg $3.20 · ctx 400k/1M · 5h 25% ↻17:00 · wk 50% ↻Mon · session $12.50 API   [ Handoff & Clear ]
```

With the [companions](#companions) installed, the cold strip also offers ways on that call no model.

## The cold-send guard

Any model call in a cold session sends the whole conversation again, uncached, before Claude reads a word of it. In a big session that went cold overnight with a question open, the answer is what pays for that. The guard holds that message first, so you can choose.

When the cache is cold and the next message would re-read at least the guard's threshold (150k tokens by default, counted as the strip's `cold $` is, on the newest figure: the status line's, or the session's own usage where that was read later), a message you type is held instead of sent:

- In its place you read what sending it would cost, in tokens and at the strip's price, and what to do. The text goes back in the prompt box, and the strip shows `message held`.
- **Enter again on the same text sends it**, once. The guard asks; it never refuses.
- **Handoff & Clear** carries it: the fresh prompt gets the brief, then the held text. The brief costs about what sending the message would.
- With a companion, **Use Latest Handoff** or **Pack & Clear**, pressed or typed (`/use-latest-handoff`, `/pack-and-clear`, `/cache-keeper latest|pack`), clears the session and fills the fresh prompt with the pointer, then the held text, with no model call. A typed command takes the prompt box, so the held text comes from what the guard kept, not from the box. Nothing is sent: press Enter when it reads right.

It holds your own words alone: a message typed, or sent through Remote Control. Never a slash command, a `!` shell line, a message typed over a running turn, or one a plugin, a background task or another session sends. Never the first message of a conversation, which has nothing to re-read: a new session's, or the one a `/clear` just started, which is where the carried text goes. Never in a session that is not interactive, nor in a hub worker (see [Companions](#companions)). What was attached to a held message (an image, a file) cannot go back in the prompt box: you are told to attach it again. The held text is kept in `~/.claude/cache-keeper/live/<session>.held.json`, so a reload of the module keeps it. A message of yours that goes in, or a way that carries it, spends it.

`/cache-keeper hold <tokens>` sets the threshold (`150000`, `150k`, `1.5m`), `/cache-keeper hold off` turns the guard off, and `/cache-keeper` shows the setting and what is held.

## Claude's question on a cold cache

A question Claude asks in its dialog (AskUserQuestion) keeps the turn running until you answer, all night if need be. So the cold-cache ways have no end of turn to wait for, and an answer would go to the model with the whole conversation uncached.

An answer given on a cold cache, over the guard's threshold, is held as a typed message is. The turn is ended before the model reads it, with no model call, and the answer goes back in the prompt as text: "My answer to its question:", then each question with what you chose, any note, and any words of your own. Enter sends it here as your next message; Handoff & Clear, or a companion's way, carries it to a fresh session. Once the cache has gone cold, a line under the open dialog says so.

Claude Code does not run the status line while the dialog is open, so the status line's figures can be a request behind the one that asked, and for a question in a session's first reply there are none yet. So at each of these checks, the line under the dialog and the answer, Cache Keeper also reads the session's own usage (`$.session.usage()`) and goes by whichever figure was read later. An answer to a question in a session's first reply is judged the same way. Each read of the session usage gets one second: one that has not answered by then counts as refused, and the figure read before stands, so neither the answer nor the strip waits on it.

The cache's clock has the same gap, and a second time to go by. While the dialog is open, Cache Keeper counts the cache from the later of two times: the last request the status line saw, and the start of the turn that asked. The request that asked read the cache when it started, at or after both, so the clock is never late and a cold cache is never missed. It can be early, by the time from the later of the two to the start of the request that asked: next to nothing when the turn's first request asks, and where earlier requests of the turn ran first, the time since the last one the status line saw began. A session that went cold and was sent anyway, whose first request asks a question, is warm under the dialog: that request has just written the cache again. A question in a session's first reply, with nothing measured yet, counts from the turn's start on the fallback window (`1h?`). The strip, the warning, the line under the dialog, `/cache-keeper` and the hold all count the same way. Where Cache Keeper did not see the turn start (it was loaded again mid-turn), it goes by the status line alone. So does the guard for a message you type: the status line runs whenever the prompt box shows, and a turn that made no request proves nothing.

A question left open stays open until it is answered. Claude Code ends the dialog by itself only where its `askUserQuestionTimeout` setting (`/config`, "Question auto-continue timeout") is `60s`, `5m` or `10m`: after that long idle it goes on with whatever was chosen. The default is `never`. In some remote sessions it can also take a client's report that nobody answered. An answer given either way is marked as given while you were away, and Cache Keeper never holds it.

Not held: an answer the dialog gave on its own while you were away, a dialog closed with nothing in it, a subagent's question, one a plugin asks, an answer in a hub worker or outside an interactive terminal session, or one given while a way on is already running (Pack & Clear ends the question's turn itself). If Claude Code will not end the turn, the answer goes to Claude.

## Companions

Cache Keeper works alone. Two tools of the author's each add a way on once the cache is cold, neither a model call. Use Latest Handoff is shown beside the other button when the session's latest handoff is current. Pack & Clear takes the place of Handoff & Clear. With both:

```
○ cache cold since 15:00 · next msg $3.20 · ctx 400k/1M · 5h 25% ↻17:00 · wk 50% ↻Mon · session $12.50 API   [ Use Latest Handoff ] [ Pack & Clear ]
```

Pressed or typed while Claude is working, both queue and run once the turn ends, as Handoff & Clear does. If anything fails (the handoff gone, acct-sync failing), nothing is cleared and the toast says why. Typed, they are commands Cache Keeper answers itself, so they cost no model turn either: `/use-latest-handoff` or `/cache-keeper latest`, and `/pack-and-clear` or `/cache-keeper pack`.

### Use Latest Handoff, with handoff-guard

[handoff-guard](https://github.com/gjovanov/handoff-guard) keeps a record of each session's newest handoff. Use Latest Handoff is for the session that wrote a handoff and then went idle: you worked, went offline, and a handoff was written. It is shown when handoff-guard's record of the session (`~/.claude/handoff-guard/live/<session>.json`) says the newest handoff it wrote is current, with no turn of work after it, and the file is a handoff document.

Most files that sessions write in the handoff folders are side notes (PR bodies, step logs, drafts). A file counts as a handoff when it is a Markdown file:

- under `handoffs/<project>/`, not in its `acct/` packs, and named for when it was written (`2026-01-31-0930-<slug>.md`), or with "handoff" in its name, or opening on a `# Handoff` heading;
- under `hub/`, with "handoff" in its name;
- or a brief saved for this session in Cache Keeper's `handoffs/` or an auto-handoff plugin's `autohandoff/briefs/`.

One press reads the record again, checks the file is still there, runs `/clear`, and pastes a pointer to it: "Continue from this handoff brief, written by my previous session (…) at …. Read <path> in full first, then carry on from it."

While Claude's question is open, Use Latest Handoff waits: the handoff was written before the question, and would carry on without it. The strip then offers Pack & Clear alone (where acct-sync is installed), and `/use-latest-handoff` says why. Once your answer is held, both ways carry it: the answer names its question.

### Pack & Clear, with acct-sync

[acct-sync](https://github.com/gjovanov/acct-sync) is a separate tool of the author's, one Node file. Cache Keeper looks for it at `~/.claude/tools/account-sync/acct-sync.mjs`, where its README's install puts it. acct-sync builds a pack from the transcript with no model call (`handoff <session> --kind clear`): every prompt the person typed, the session's own last handoff or compaction summary, where it stopped, the files it edited, the background work still running. The pack goes to `~/.claude/handoffs/<project>/acct/`. Then `/clear`, and a pointer to the pack in the prompt. A 500 MB transcript takes about 25 seconds; the button says `Pack: building the pack…` meanwhile. Where acct-sync is not installed, the cold strip keeps Handoff & Clear, and `/pack-and-clear` and `/cache-keeper pack` say why.

Some sessions have no transcript: Claude Code saves none for a process started from inside another Claude session, which sets `CLAUDE_CODE_CHILD_SESSION`. Pack & Clear then exports the conversation as the engine holds it (`$.session.messages({ as: 'api' })`) to `~/.claude/cache-keeper/exports/<session>.json`, and acct-sync builds the pack from that; it turns the export into `<session>.jsonl` beside it, which the pack names for looking details up. A plugin may write no file over 4 MiB, so the export leaves out thinking and media and keeps within 3.5 MB, cutting long tool output, and at worst the oldest messages, where it must. The pack says what was cut. `/cache-keeper` says whether this session's transcript is saved.

With Claude's question open, Pack & Clear does not wait for the turn. acct-sync builds the pack first, while the question still stands unanswered in the transcript; then the turn is ended, with no model call, and the session clears. Where no transcript was saved, the export keeps the question's call whole (every question, header and option) and no result for it, so the pack can show the open question in full. If the engine will not end the turn, nothing is cleared and the toast says why.

### The hub

The hub is the author's tool for running Claude Code sessions as workers of one coordinating session. It is not published. A session with `HUB_WORKER` set is such a worker: its cold strip keeps Handoff & Clear and offers no other way, and the guard holds nothing there. For a hub's own handoff, in its folder under `hub/`, Use Latest Handoff pastes `/hub resume <id>` in place of a pointer, and never over a draft: the draft stays, and the toast says what to send after it.

## Settings

`/cache-keeper` shows the state and settings. Settings are kept in `~/.claude/cache-keeper/config.json`.

| Command | Default | |
|---|---|---|
| `/cache-keeper handoff` | | Handoff & Clear, as the button does. |
| `/cache-keeper latest` | | Use Latest Handoff (also `/use-latest-handoff`). |
| `/cache-keeper pack` | | Pack & Clear (also `/pack-and-clear`). |
| `/cache-keeper hold <tokens>\|off` | `150k` | Hold a message typed into a cold session that would re-read this many tokens or more (1000 or more; `150000`, `150k`, `1.5m`). `off` turns the guard off. |
| `/cache-keeper ttl auto\|<minutes>` | `auto` | `auto` uses the window Claude Code measured; a number forces one. |
| `/cache-keeper fallback <minutes>` | `60` | The window to assume when none was measured. |
| `/cache-keeper warn <minutes>` | `5` | How long before cold to warn; `0` turns the warning off. |
| `/cache-keeper notify on\|off` | `on` | The warning: the desktop notification and the toast in Claude Code. |
| `/cache-keeper statusline auto\|always\|off` | `auto` | The line under the prompt. `auto` shows it only where the strip above is not running. |
| `/cache-keeper brief paste\|send` | `paste` | After Handoff & Clear, put the brief in the prompt, or send it straight away. |
| `/cache-keeper limits <seconds>\|off` | `60` | How often one session reads the account limits from the usage endpoint (15–3600 seconds). `off` stops it. |
| `/cache-keeper test-notify` | | Send the notification now. |

## Kept on disk

Cache Keeper keeps its files in `~/.claude/cache-keeper/`, or in `cache-keeper/` under `CLAUDE_CONFIG_DIR` where that is set.

| Path | What it holds |
|---|---|
| `config.json` | The settings. |
| `limits.json` | The account's newest 5-hour and weekly figures, and the poll's bookkeeping: when it last asked, which session asked, the last error. No credential. |
| `live/<session>.json` | The status line's snapshot of a session: its id and name, working folder, transcript path, model, cache, context size, limits and cost. |
| `live/<session>.module` | The module's heartbeat: a time and its version. |
| `live/<session>.notified` | The cache expiry the warning was last sent for. |
| `live/<session>.held.json` | What the guard holds: the message you typed, or your answer to Claude's question with the questions. Once it is sent or carried, the file keeps no text, only that it was used. |
| `live/<session>.trace.jsonl` | Only with `CACHE_KEEPER_TRACE` set (see [Testing](#testing)): one JSON line per hold decision, with its figures and ids and no text of a message or an answer. |
| `live/<session>.ui.jsonl` | Only with `CACHE_KEEPER_TRACE_UI` set: one JSON line each time what the band or the footer is handed to draw, or draws, changes. No text of the strip. |
| `handoffs/` | Every brief Handoff & Clear saved, one Markdown file each. |
| `exports/<session>.json` | Written only by Pack & Clear, where no transcript was saved or acct-sync found none: the conversation as the engine held it, with no thinking or media and long pieces cut, within 3.5 MB. acct-sync writes `<session>.jsonl` beside it. |

Only the status line deletes anything, and only in `live/`: about one run in fifty deletes the files there that are more than 3 days old. Without the status line, nothing is deleted. `handoffs/` and `exports/` stay until you delete them. Packs are acct-sync's, in `~/.claude/handoffs/<project>/acct/`.

## How it is put together

```mermaid
flowchart LR
  CC[Claude Code] -- status line input:<br>prompt_cache, context, limits, cost --> SL[bin/statusline.mjs]
  SL -- live/&lt;session&gt;.json --> M[hooks/register.ts<br>function-hooks module]
  M -- band above the prompt --> CC
  M -- toast, PowerShell --> W[Desktop notification]
  M -- model.fork, /clear, prompt.fill --> CC
  CC -- prompt.submit, tool.call:<br>a cold send, an answer --> M
  M -- held, turn.abort --> CC
  SL -. fallback: line under the prompt,<br>notification .-> W
  M -- session.measure: a response's windows --> L[limits.json<br>one per account]
  M -- once a minute, one session:<br>authorize + http.fetch --> U[api.anthropic.com<br>/api/oauth/usage]
  U --> L
  L -- the newest reading --> M
  L --> SL
  HG[handoff-guard, optional<br>live/&lt;session&gt;.json] -- the newest handoff,<br>current or not --> M
  M -- Pack & Clear: handoff --kind clear,<br>or an engine export --> A[acct-sync, optional] -- the pack --> M
```

- **`bin/statusline.mjs`** is the status line command. Claude Code hands it its cache tracker on every update and every 30 seconds. It writes a snapshot per session. In a session where the strip is not running (mods off, for one), it draws the same facts under the prompt and sends the warning itself.
- **`hooks/register.ts`** is the hooks module. It draws the strip in the band above the prompt (and its buttons under the prompt while the band has no row for them), ticks every second, sends the warning, runs Handoff & Clear and, once the cache is cold, Use Latest Handoff and Pack & Clear, holds a cold send and a cold answer, and keeps `limits.json` current (see [Account limits](#account-limits-live-in-every-session)). It writes a heartbeat (`live/<session>.module`: the time, then the version that beats), and the status line stands down while the heartbeat is fresh. Saving a file in the plugin's folder reloads the module in every running session that loads it from there, and each one binds again (`session.start` fires for a reloaded module).
- **`hooks/core.mjs`** holds the shared arithmetic: prices, cache states, the transcript fallback, the guard's texts and formatting. It is pure, so both sides import it. Prices are Claude Code's own model catalog, as of 2.1.322, so the figures agree with `/cost`. Claude Haiku 5.5 has two rate cards, and the one used depends on how long the prompt is.

Cache Keeper finds its files under Claude Code's config directory: `CLAUDE_CONFIG_DIR`, else `.claude` in the home folder as Node's `os.homedir()` reads it, which the status line uses too. That is `USERPROFILE` on Windows and `HOME` everywhere else, so a Linux or WSL session that has a Windows `USERPROFILE` in its environment still keeps its files under `HOME`.

## Testing

```sh
claude plugin test <the plugin's folder>
```

There are 180 tests on Claude Code's own engine kit:

- **The arithmetic**: prices, Claude Haiku 5.5's two cards among them, cache states, the cache's clock under Claude's question, the newest token figure of two readings, the transcript parser, the settings and `CACHE_KEEPER_TTL`, the guard's texts, and the export, which keeps Claude's open question whole at any size and drops a result for it.
- **The strip**: its countdown and the terminal's acceptance of what it draws; a narrow row that keeps its buttons whole; the buttons under the prompt while the band has no row (the task list, a collapsed band, a survey), back up once it has one, never on screen twice in either order the two places are drawn, taken back from a footer no longer drawn, dim while Claude works, the mode labels kept beside them, and Handoff & Clear pressed there; the warning and its de-duplication; a Windows notification with no text in the code it runs; where the files are on Windows, Linux (a Windows `USERPROFILE` carried in) and macOS.
- **Handoff & Clear** end to end: fork, clear, paste, a queued press, a failed fork, and a kept draft.
- **Once the cache is cold**: which buttons show (a current handoff, work after it, no record, a warm cache, a hub worker, no acct-sync); Use Latest Handoff end to end, a hub's handoff, a draft kept from a command, a side note that is not a handoff and a file whose first line says it is, a handoff gone by the press; Pack & Clear from a transcript, from an engine export when none was saved or acct-sync knows no such session, with nothing to export, acct-sync missing, failing or installed later, the button while it builds, a second start refused; the typed commands, queued behind the moment the engine shows Claude working after one, behind a real turn, or until the prompt has shown Claude idle a second when no turn is reported, and a press queued while Claude works that runs once; the status.
- **The cold-send guard**: a hold, with its cost, the ways, and the text back in the prompt; Enter again, on the text as the box hands it back (marks drawn as nothing, a letter composed another way), and a different text; not held when warm, under the threshold, turned off, in a hub worker, for a command, a meta prompt, a message typed over a running turn, a shell line, one that is not the person's, or the first message of a conversation, new or after a `/clear`; an attached image; carried by each button and each typed command, after a hub's own handoff command, by Handoff & Clear, and through a clear that takes its time; kept over a module reload, and another session's not taken; the overrides below.
- **Claude's question**: an answer held, its turn ended and Enter sending it; carried by Pack & Clear; not held under the threshold, when given while away, when empty, or on a warm cache; Pack & Clear with the question open, by button and by command, from an export, and with the engine refusing to end the turn; the dialog it closed giving no answer; Use Latest Handoff waiting; the line under the dialog. Judged on the request that asked: a question from a session's first reply, with no status line snapshot and with one that has no figures yet; a status line a request behind, for a typed message and for a question; a status line newer than the last read of the session usage, when the engine will not answer that read; and no figure from before a compaction. The cache's clock under the question: a turn that asks 40 minutes after the last request (warm under the dialog, the line under it and the hold only once that turn's window ends), one sent on a cold cache, a first reply's on the fallback window, a long asking request, a question mid-turn; the status line alone where the module was loaded mid-turn, and for a typed message after a turn that made no request; no status line, caching off and `CACHE_KEEPER_ASSUME_COLD` as before; a read of the session usage that never answers. The trace, with no text in it.
- **The account limits**: the endpoint's answer in its own shape; an idle session showing it; one poll a minute between sessions, with a claim and a shared backoff; no poll with an API key or with polling off; a response that updates every session, and one that trails the file and changes nothing; a window's reset, and another login's; a model's limit that ages with the endpoint's last answer and stands only beside its own week; another login's reading in the file; a half-written file; and a response that lands while the module binds.

Three environment variables let a test in a real session reach the guard without a night's wait for the cache to go cold, and without touching `config.json`, which every session on the machine shares. A fourth records what the guard decided, and a fifth what the strip and its buttons were given to draw. The module reads them when it binds; the status line reads `CACHE_KEEPER_ASSUME_COLD` and `CACHE_KEEPER_TTL` on each run:

| Variable | What it does |
|---|---|
| `CACHE_KEEPER_HOLD_COLD_AT=<tokens>` | The guard's threshold for this session, over the setting: `1000`, `150k`, `off`. |
| `CACHE_KEEPER_ASSUME_COLD=1` | The cache counts as cold: the strip says `○ cache cold (assumed)`, with no time, and the guard and the cold-cache ways act on it. |
| `CACHE_KEEPER_TTL=<minutes>` | The cache's window for this session, over the `ttl` setting: minutes (1 to 1440), or `auto` for the one Claude Code measured. The strip, the warning, the line under Claude's question and the guard all count with it, and `/cache-keeper` says `forced by CACHE_KEEPER_TTL`. Set to `2`, a test sees the hold under Claude's question on a real clock in two minutes. |
| `CACHE_KEEPER_TRACE=1` | Each hold decision is appended as one JSON line to `live/<session>.trace.jsonl`: Claude's question as it opens, the answer as it comes back, the cache state, what its clock counted from (the status line's last request, or the start of the turn that asked) and when it goes cold, the token figure and which reading it came from, the threshold, why the answer was let go or that it was held, and how ending the turn went. Ids, figures and names only, never the text of a message or an answer. |
| `CACHE_KEEPER_TRACE_UI=1` | Each time what the band above the prompt or the footer under it is handed to draw, or draws, changes, one JSON line is appended to `live/<session>.ui.jsonl`: the rows and columns it has, whether Claude is working, whether the band is collapsed, the cache state, and which buttons each place drew. A run of identical drawings is one line with its count. No text of the strip. |

`/cache-keeper` names an override that is in force.

`tests/usage-fixture.ts` is the usage endpoint's answer in its own shape, with made-up figures. A real answer, to check the parser against when the endpoint changes, goes in `.secrets/usage-capture.json` at the repository's root, which `.gitignore` keeps out of the repository. The engine kit lets a test read no file of its own, so no test loads it: compare it by hand.

For the status line, set `CACHE_KEEPER_DEBUG=1` to have it explain on stderr why it printed nothing.

## Developing

Run Claude Code with a clone as its plugin folder, `claude --plugin-dir <clone>`, in place of the installed copy: a saved file then reloads the module in that session. Once it has loaded the plugin, the engine lays its declaration files in `<clone>/.claude-plugin/types/`, with a `.gitignore` of their own, for an editor and `tsc`.

## Uninstall

1. **The plugin**: `/plugin uninstall cache-keeper` at the prompt, or `claude plugin uninstall cache-keeper` from a shell.
2. **The status line**: take the `statusLine` entry out of `~/.claude/settings.json`, or put back the one you had.
3. **The data folder**: delete `~/.claude/cache-keeper/` (see [Kept on disk](#kept-on-disk)).

## License

MIT. See [LICENSE](LICENSE).
