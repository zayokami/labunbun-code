# Out-of-box experience

What a brand-new user meets when there is no `~/.labunbun/settings.json` and no credential anywhere on the machine, what OpenAI's Codex CLI does in the same position, and the first-launch flow this app should build. This is a design note: of §6's four batches, batches 1 through 4 are implemented (`149c620`, `9403213`, `64b62c1`, `b081003`). Four deviations rode in with batches 2–4, noted in place: the import offer runs after the settings write (§4 Screen C), the trigger stays file-gated — the condition-driven re-offer from §3's verdict row is not built (§6) — the one-shot record is written but never read (§4 Screen G), and the git-root sentence states this directory's scope rather than Codex's repository-root claim, because this app's trust ledger is keyed by the cwd (§6 batch 4). Screen F's notice landed early with batch 1 — a gate that warns instead of exiting needs the warning to exist.

Every claim about this repository cites `path:line`. Every claim about Codex cites `path:line` inside `openai/codex` at `main`, fetched on 2026-10-14 with `gh api` and quoted verbatim; upstream moves, so re-fetch before quoting it again.

## 1. Current state

### The call path from an empty home

Bare `labunbun` enters at `packages/coding-agent/src/main.ts:499-501`, parses arguments (`main.ts:292-302`), and dispatches. Subcommands run before the model resolves and before any key is needed — `yoshi` (`main.ts:321-337`), `login`/`logout` (`main.ts:343-352`), `acp` (`main.ts:410-436`) — deliberately, because "importing a configuration is exactly what someone does when they have no working configuration yet" (`main.ts:318-320`).

The interactive path prints one line and hands over:

- `main.ts:486` — `labunbun 0.1.0 — starting interactive mode…`. This is the first thing a new user sees on any platform.
- `main.ts:487-496` → `runInteractive` (`packages/coding-agent/src/interactive.ts:386`).

`runInteractive` then does, in order:

| Step | Where | What it means for a new user |
| --- | --- | --- |
| First-run wizard | `interactive.ts:399`, gated by `shouldRunWizard` (`packages/coding-agent/src/wizard.ts:53-57`) | Runs only when stdin is a TTY **and** `~/.labunbun/settings.json` does not exist |
| Settings load | `interactive.ts:402`, `loadSettings` (`packages/coding-agent/src/settings.ts:583-622`) | Four file tiers, no file is fine — everything falls back to defaults |
| Env from settings | `interactive.ts:412`, `applySettingsEnv` (`settings.ts:705-713`) | A key stored by the wizard becomes a real environment variable here; a real env var always wins |
| Model resolution | `interactive.ts:447-461` | `--model`, else `settings.model`, else the main role, else `anthropic/claude-sonnet-5` |
| Key warning (was a gate) | `interactive.ts:466-471`; the notice at `:2001-2007` | Batch 1 removed the gate: no exit. A model the machine cannot run gets one info line naming the fix before anything is typed |
| Credential providers | `interactive.ts:715-717` | The subscription stores are constructed here; the startup notice reads them only when the environment answers nothing |
| REPL mount | `interactive.ts:1720` | First frame: empty transcript, status line, prompt |

### What the wizard asks — as batch 2 extended it

`runWizard` (`wizard.ts:420-572`) is a plain console + readline flow — no ink, because no session exists yet. It prints `Welcome to labunbun — first-time setup. Press Enter to accept [defaults].` and the project directory (`wizard.ts:421`), then shows what the machine holds and asks, in order:

1. The detection block (batch 2) — `Found on this machine:` followed by one row per detected migration source (label and tree), one per set key variable, one per subscription sign-in (`wizard.ts:430-442`, rows composed by `wizardDetectionLines`, `wizard.ts:197-207`). Printed only when non-empty.
2. `How do you want to use labunbun?` — four numbered rows (`wizard.ts:446-458`), defaulted by `wizardProviderDefault` (`wizard.ts:180-186`): `1` when a Claude config was detected, else `3` when a key variable is set, else `1`. Row `1` runs the Claude sign-in, row `2` the ChatGPT flow (`wizard.ts:475-482`; a failed sign-in prints a retry line and the wizard continues). Row `3` skips the paste when an anthropic variable is already set and otherwise reads it masked (`wizard.ts:484-493`, reader at `wizard.ts:250-295`). Row `4` is the old `openai-compatible` question set (`wizard.ts:494-508`).
3. `Theme (dark/light… or auto) [auto]:` (`wizard.ts:513`, choices built from the TUI's own list at `wizard.ts:153`; the default became `auto` in batch 2).
4. `Editing model (vim, emacs, or none) [none]:` (`wizard.ts:517`, `wizard.ts:168`).

It writes `~/.labunbun/settings.json` and prints `Settings written to <path>.` (`wizard.ts:533-537`), then — when the detection block found a source — offers the import (Screen C, `wizard.ts:540`), and prints `Type /help in a session to see commands.` last (`wizard.ts:554`). Ctrl+C before the write leaves `{}` and prints `Setup skipped — the session starts anyway. Run /login or /yoshi in it, or edit ~/.labunbun/settings.json.` (`wizard.ts:565-566`); a throw after the write leaves the file standing and names `/yoshi` (`wizard.ts:556-559`).

The wizard now reaches both of the things a first-time user could not find: the two sign-ins are rows 1 and 2 of the payment question, and `/yoshi`'s engine runs behind the import offer. `labunbun login` remains the non-interactive spelling.

### Where a new user dead-ends

**(a) No key and no TTY — the exit is fixed in batch 1; the wizard is still TTY-gated.** Measured before batch 1 on this checkout with an empty fake home (`HOME`/`USERPROFILE` pointed at a temp directory, `ANTHROPIC_*` unset, stdin not a TTY):

```
labunbun 0.1.0 — starting interactive mode…
Missing API key for anthropic: set ANTHROPIC_API_KEY or ANTHROPIC_AUTH_TOKEN in your environment.
Example: export ANTHROPIC_API_KEY=sk-...
```

Exit code 1, and the identical run repeated forever because the wizard is TTY-gated (`wizard.ts:55-56`), so no settings file was written. The gate is gone (`interactive.ts:466-471`): the run proceeds to mount, and the transcript carries one line naming the fix (`interactive.ts:2001-2007`). A non-TTY editor or CI shell no longer meets a startup refusal: the miss — if it remains one — surfaces at request time, where the error names the variable, exactly as it always did for `-p` runs and ACP.

**(b) Wizard cancelled.** The empty `{}` file disables the wizard permanently (`wizard.ts:56`, asserted in `packages/coding-agent/test/wizard.test.ts`) and the next run used to land in (a)'s exit — it now starts. Nothing re-offers setup: the condition-driven trigger sketched for batch 2 was not built (the gate is sync, runs before settings load, and the wizard's write is a whole-file write, so re-offering over an existing file needs a merge story this note does not have — recorded as a deviation in §6). What batch 2 changed here is the repair text: it now names `/login` and `/yoshi` and says the session starts anyway (`wizard.ts:565-566`), instead of telling the user to delete the file the app just wrote.

**(c) A Claude-subscription-only machine cannot start the REPL — fixed in batch 1.** `labunbun login` stores a credential (`packages/coding-agent/src/claude-auth.ts:104-151`) and writes nothing else; the tree's only writer of `ANTHROPIC_API_KEY` is the wizard's own `settings.env` (`wizard.ts:121`). The old gate called `missingApiKey(model)` with the default `subscription = false` (`packages/ai/src/index.ts:300-312`), which asks `resolveApiKey` — an environment lookup only (`packages/ai/src/model.ts:1624-1630`) — so it reported "missing" even when the machine is signed in. The request-time rule is the opposite: `packages/ai/src/index.ts:341` passes `subscription = true` for anthropic, so a request from a signed-in user is allowed to proceed. The README documents the subscription as a supported substitute for the key ("You can use a Claude subscription in place of an Anthropic API key"), `headless.ts` has no pre-gate at all, and `acp.ts` has none either — only the interactive path refused to open. Batch 1 replays the request-time rule synchronously (`credential-presence.ts`'s `modelMayRun`, reading the sign-ins the caller already probed) with the stores constructed at `interactive.ts:715`.

**(d) A ChatGPT-subscription-only machine lands in (c) too — fixed in batch 1 the same way.** `labunbun login chatgpt` stores its credential (`packages/coding-agent/src/chatgpt-login.ts:124-166`) and writes no setting, so the model stays `anthropic/claude-sonnet-5` (`interactive.ts:447`). (ChatGPT rows themselves are always offered — they name no env var, and `missingApiKey` reads an empty name list as "nothing to miss", `packages/ai/src/index.ts:309`.) The machine now starts; the notice says what is missing, and batch 2 added decision 3: a ChatGPT sign-in through the wizard writes `chatgpt/gpt-6-astra` as the model (`wizard.ts:94`, `wizard.ts:97-142`).

**(e) The same env-only answer was printed in two more places — all four surfaces agree now (batch 1).** `/doctor`'s Auth row used to mark the machine `fail` and print `none of … set` for a signed-in user; it now names each subscription (`doctor.ts:133-144`). `/model`'s picker annotates an unrunnable row by wire — `— no API key or sign-in` for anthropic, `— no ChatGPT sign-in`, `— no API key` elsewhere (`interactive.ts:3075-3096`) — and the band's `canRunModel` uses the identical rule (`interactive.ts:1660`). Before batch 1 these three surfaces disagreed with the request path; now no two of the four disagree.

### The first frame, once a key resolves

Nothing is drawn for a new user's benefit. All startup text goes to stderr through `console.error` before the frame (`interactive.ts:408-590`), and the in-transcript startup lines are the withheld-project-definitions notice, one line per unloaded skill folder, and MCP config errors (`interactive.ts:1976-1993`), the credential notice when the model cannot run (`:2001-2007`, batch 1), and a gamepad failure line (`:2014-2020`), all via `pushInfo`. The first frame is then: empty transcript, status line, and the prompt with the placeholder `Try "fix the failing test" — / for commands` (`packages/tui/src/components/PromptInput.tsx:163`). The terminal title reads `labunbun — <dirName>` (`packages/tui/src/components/TerminalTitle.tsx:61`). There is no banner, no version line, and no "here is what to do next" line.

### What already exists for a new user

Nothing below is speculative; each is a mechanism the first-run flow can reuse:

- **20 migration sources** — `MIGRATION_SOURCE_IDS` (`packages/coding-agent/src/migrate-types.ts:58-79`) with labels (`:82-103`); `detectSources(home)` answers "which of these has content here" by looking inside the trees, not at directory existence (`migrate-types.ts:225-236`). The REPL flow is `/yoshi` (`packages/coding-agent/src/commands.ts:154-183` → `runMigrationWizard`, `packages/coding-agent/src/migrate-wizard.ts:250-317`), the CLI spelling is `labunbun yoshi` (`main.ts:321-337`), and the default is a dry run with the report printed.
- **Two subscription sign-ins** — `/login [claude|chatgpt]` (`interactive.ts:2727-2728`; handler at the `/login` case, `interactive.ts:3900`) and the CLI (`main.ts:343-352`). The Claude flow prints a URL, opens a browser, and falls back to a pasted `code#state` when the loopback port is taken (`packages/coding-agent/src/claude-login.ts:161-210`); the ChatGPT flow falls back to a device code instead (`packages/coding-agent/src/chatgpt-login.ts:124-166`). Both are console-capable and take injected `askCode`/`listen`/`openBrowser`, so a wizard can drive them.
- **A diagnostics surface** — `/doctor` (`interactive.ts:2721`, checks in `doctor.ts:80+`).
- **Project-tier trust** for repo-shipped agents and skills, held back until approved, with a notice that names the command to review it (`packages/coding-agent/src/project-trust.ts:1-29`, `:90-108`; printed at `interactive.ts:1977-1984`).
- **A startup line that reaches the transcript** — `pushInfo` (`interactive.ts:1976-1993`), including the precedent of printing nothing when nothing is wrong (`interactive.ts:2017-2019`).
- **Background terminal probing** — the `theme: "auto"` probe (`packages/tui/src/detect-appearance.ts:1-13`).
- **Advice lines are test-held** — `help-commands.test.ts` asserts that every command named in a startup notice and every row of `/help` actually dispatches.

## 2. Codex OOBE teardown

Ordered the way a new user meets it. All quotes are from `openai/codex` at `main`, fetched 2026-10-14.

### 1. The gate: onboarding is a condition, not a first-run flag

`codex-rs/tui/src/lib.rs:2362-2372` — onboarding is shown when a trust screen is needed **or** the login screen is:

```rust
fn should_show_onboarding(
    login_status: LoginStatus,
    requires_openai_auth: bool,
    show_trust_screen: bool,
) -> bool {
    if show_trust_screen {
        return true;
    }

    should_show_login_screen(login_status, requires_openai_auth)
}
```

and `lib.rs:2374-2386` decides the login screen off the live auth state, with a comment that states the rule for other providers:

```rust
    // Only show the login screen for providers that actually require OpenAI auth
    // (OpenAI or equivalents). For OSS/other providers, skip login entirely.
    if !requires_openai_auth {
        return false;
    }

    login_status == LoginStatus::NotAuthenticated
```

There is no "already onboarded" file. The screen appears whenever `codex` is run without a credential — first run and every run after a logout are the same code path. One conservative hint sits ahead of it: the composer is only held back for onboarding when `auth.json`, `config.toml` and `environments.toml` are all missing (`startup_preflight.rs:45-56`), and the file check is explicitly a hint — "the normal account lookup decides whether sign-in is required" (`startup_preflight.rs:51`).

### 2. Welcome screen

`codex-rs/tui/src/onboarding/welcome.rs` renders an animated logo in a fixed stage (`:28-31`, `:99-102`, skipped below 64 columns or 41 rows so it never clips) and one line under it (`:126-131`):

```rust
        lines.push(Line::from(vec![
            "  ".into(),
            "Welcome to ".into(),
            "Codex".bold(),
            ", OpenAI's command-line coding agent".into(),
        ]));
```

The step hides itself when the user is already signed in (`welcome.rs:139-146`: `true => StepState::Hidden, false => StepState::Complete`), and `Ctrl+.` replays the animation (`codex-rs/tui/src/onboarding/keys.rs:35-41`). `keys.rs:1` states the intent of that file: `//! Fixed shortcuts used before users have had a chance to configure Codex.` — the whole key set is `1`/`y`, `2`/`n`, `3`, `4`, Enter, Esc, `c`, `q`/`Ctrl+C`/`Ctrl+D` (`keys.rs:9-41`).

### 3. Sign-in picker — "Sign in with ChatGPT" vs API key

`codex-rs/tui/src/onboarding/auth.rs` owns the auth state machine (`:83-94`: `PickMode`, `ChatGptContinueInBrowser`, `ChatGptDeviceCode`, `ChatGptSuccessMessage`, `ChatGptSuccess`, `ApiKeyEntry`, `ApiKeyConfigured`, `Bedrock`, `BedrockConfigured`). The picker (`:439-555`) opens with two header lines:

```
  Sign in with ChatGPT to use Codex as part of your paid plan
  or connect an API key for usage-based billing
```

then a numbered list, each row a title plus a dim description; the highlighted row gets a leading `>` and cyan (`:456-483`):

| Row (verbatim) | Description (verbatim) |
| --- | --- |
| `Sign in with ChatGPT` | `Usage included with Plus, Pro, Business, and Enterprise plans` (`:485-489`, `:494-500`) |
| `Sign in with Device Code` | `Sign in from another device with a one-time code` (`:490`, `:502-508`) |
| `Provide your own API key` (or `Use an OpenAI API key` when Bedrock setup is enabled) | `Pay for what you use` (`:510-520`) |
| `Use Amazon Bedrock` | `Connect using your AWS credentials` (`:522-528`) |

Footer: `  Press <Enter> to continue` (`:542-546`). Which row is highlighted is decided before the user arrives — ChatGPT when ChatGPT login is allowed, API key otherwise (`codex-rs/tui/src/onboarding/onboarding_screen.rs:169-175`). A workspace policy that forbids the key path instead prints `  API key login is disabled by this workspace. Sign in with ChatGPT to continue.` and puts the caret back on ChatGPT (`auth.rs:534-540`, message constant at `:104`).

The API-key state (`auth.rs:693-746`) is a bordered input titled `API key` (`:730-735`) with the intro `> Use your own OpenAI API key for usage-based billing` / `  Paste or type your API key below.`, and — this is the part worth copying — an env-var pre-detection block:

```
  Detected OPENAI_API_KEY environment variable.
  Paste a different key if you prefer to use another account.
```

(`:710-718`), the first typed character clearing the pre-filled value (`:786-796`). Empty submit is refused with `API key cannot be empty` (`:774`); a save failure surfaces as `Failed to save API key: {err}` (`:910`). Footer: `  Press <Enter> to save` / `  Press <Esc> to go back` (`:739-748`).

### 4. Browser and device-code states

Browser wait (`auth.rs:557-618`): a shimmering `Finish signing in via your browser`, `If the link doesn't open automatically, press c to copy it:`, the URL in cyan underline wrapped in OSC 8 so the whole region is one clickable link (`:614-618`), plus a signpost to the alternative:

```
  On a remote or headless machine? Press Esc and choose Sign in with Device Code.
```

and `  Press Esc to cancel` (`:605-609`).

Device code (`codex-rs/tui/src/onboarding/auth/headless_chatgpt_login.rs:92-142`) is numbered instructions: `1. Open this link in your browser and sign in`, `2. Enter this one-time code after you are signed in (expires in 15 minutes)`, and a phishing warning: `Continue only if you started this login in Codex. If a website or another person gave you this code, cancel.`

### 5. Success screens, and what they say about safety

After a ChatGPT sign-in (`auth.rs:621-667`):

```
✓ Signed in with your ChatGPT account

  You're in control
  Learn about permissions and approvals in the Codex docs

  Codex can make mistakes
  Review the code it writes and commands it runs

  Included with your ChatGPT plan
  Your plan's rate limits and training data preferences apply

  Press <Enter> to continue
```

(`Learn about permissions and approvals in the Codex docs` links to `https://developers.openai.com/codex/security`, `training data preferences` to `https://chatgpt.com/#settings`, `:624-634`.) The API-key path gets the shorter `✓ API key configured` / `Codex will use usage-based billing with your API key.` (`:681-691`).

### 6. Project trust prompt

Shown after onboarding (and before a resumed thread's first turn) by `check_directory_trust` (`codex-rs/tui/src/lib.rs:1867-1876`), which builds a one-step onboarding screen around `TrustDirectoryWidget` (`codex-rs/tui/src/onboarding/trust_directory.rs`). The trust step inside the *startup* onboarding screen is hard-disabled — `let should_show_trust_screen_flag = false;` under the comment `// Folder consent runs after the picker resolves the actual destination.` (`lib.rs:1279-1280`) — so this separate call is the only path that asks. The question text is fixed and explains what trusting buys an attacker (`trust_directory.rs:69-74`):

```
Trust this folder? Codex can read, edit, and run files here, subject to
your permission settings. Folder settings can run code automatically,
even without a model request. Continue only if you trust these files.
Your trust decision will be saved.
```

Options are two rows — `Trust and continue` / `Quit` in the normal case (`:80-99`) — with footer `enter continue · esc quit` (`:121-141`). `1`/`y` only moves the highlight; the decision still needs a fresh Enter, because a terminal response fragment can start with `1` (`trust_directory.rs:222-226`). When the working directory sits inside a repository, a yellow note names the actual target of the decision (`:144-152`):

```
Note: You’re in a subdirectory of a Git project. Trusting will apply to the repository root:
```

Resume and restricted variants replace the wording (`:61-68`) and the second option (`Open restricted`, `Open existing task`, `Back to Agent Command Center`, `Keep current directory`, `:82-98`), and on Windows a third footer variant offers `continue and create sandbox` (`:125-129`). Refusing does not silently downgrade: cancelling the *auth* menu exits the app rather than leaving the user at a prompt in an unauthenticated state (`codex-rs/tui/src/onboarding/onboarding_screen.rs:359-364`).

### 7. Tips

`codex-rs/tui/src/tooltips.rs:60-63` picks one tip when the session starts:

```rust
/// Pick a random tooltip to show to the user when starting Codex.
pub(crate) fn get_tooltip(plan: Option<PlanType>, keymap: &TuiKeymap) -> Option<String> {
```

The corpus is an asset, `codex-rs/tui/assets/tooltips.txt`, loaded with `include_str!` (`tooltips.rs:29`), rendered as markdown under the prefix `**Tip:** {tip}` (`tooltips.rs:126-135`) into a one-line expendable row (`codex-rs/tui/src/turn_tip.rs:1-2`). The format supports live key bindings via `{key:context.action}` placeholders, and a tip is skipped when the action it names is unbound (`assets/tooltips.txt:1-3`). The first lines of the corpus are slash-command teaching (`/new`, `/feedback`, `/model`, `/permissions`, `/review`, `/skills`, `/init`, `/mcp`, …), including the one that matters here:

```
Moving from Claude Code? Use **/import** to bring over your setup, project, and recent chats.
```

An announcement/promo path can override the random pick and the app-desktop tooltip wins 8 times in 10 when present (`tooltips.rs:70-81`, `:24-27`).

### 8. Import from another agent

`/import` is `codex-rs/tui/src/external_agent_config_migration/`, reachable only by typing the command — it is `import setup, this project, and recent chats from Claude Code` (`slash_command.rs:117`), dispatched as `AppEvent::OpenExternalAgentConfigMigration` (`chatwidget/slash_dispatch.rs:538-541`, handled at `app/event_dispatch.rs:489-505`). Nothing offers it automatically, and the tip in §7 is the only place it is advertised. Its sources are other agents, labelled literally `"Claude Code"` and `"Cursor"` (`source.rs:41-44`). The prompt is a review screen, not a yes/no: items render as `[x]` checkboxes grouped under `Current project: <path>` / `Home` (`mod.rs:590-598`, `:672-680`), each with a description line (`:682-690`), and the action rows are `Import selected`, `Customize selection`, `Cancel`, `Review selection` (`mod.rs:47-52`). The run prints `Import started.` with the item list, then `Import finished: N imported` with per-type counts and `Run /import again to check for additional items.` (`flow.rs:145-235`); with nothing to offer, `No compatible setup was found to import.` (`flow.rs:20`).

### 9. Update prompt

`codex-rs/tui/src/update_prompt.rs:203-269` — a screen shown at startup, release builds only and skipped when an initial prompt argument is given (`#![cfg(any(not(debug_assertions), test))]` at `:4`; `lib.rs:1186-1191`): `Update available · {current} → {latest}`, `Release notes: <url>` (the release URL constant at `:42`), options `Update now (runs `{update_command}`)`, `Skip`, `Skip until next version`, footer `enter continue · esc skip`. Choosing `Update now` exits the startup with the update action attached, before the app server starts (`lib.rs:1195-1204`).

### 10. `codex login` on the command line

`codex-rs/cli/src/login.rs`. `codex login` runs the browser flow and prints `Successfully logged in` on success (`:48`, `:198-236`), with the server line and the headless signpost at `:120-124`:

```
Starting local login server on http://localhost:{actual_port}.
If your browser did not open, navigate to this URL to authenticate:

{auth_url}

On a remote or headless machine? Use `codex login --device-auth` instead.
```

`codex login --with-api-key` reads the key from stdin and refuses a terminal, printing the exact recovery in the error: `--with-api-key expects the API key on stdin. Try piping it, e.g. `printenv OPENAI_API_KEY | codex login --with-api-key`.` (`:281-287`, guard at `:297-303`). A headless environment is detected and the device flow preferred, with a documented fallback to the browser flow when device code is unavailable (`:370-374`). Failed logins are logged to a durable `codex-login.log` in the log directory, mode 0600 on unix (`:52-118`).

## 3. Gap analysis

| Dimension | labunbun today | Codex | Verdict |
| --- | --- | --- | --- |
| When the setup screen appears | Only when `~/.labunbun/settings.json` is absent, and only on a TTY (`wizard.ts:53-57`) | Whenever no credential resolves; no persisted "done" flag (`lib.rs:2362-2386`) | **Partly copied (batch 2)**: the file check stays as the whole trigger; the condition half is not built — the gate is sync and pre-settings-load, and the wizard's write is whole-file, so a re-offer over an existing file needs a merge story (§6). A cancelled or signed-out user gets Screen F's notice, not the wizard |
| Sign-in in the first flow | Absent from the wizard; only `/login` inside the REPL or `labunbun login` on the command line | First-class, option 1, highlighted by default when allowed (`onboarding_screen.rs:169-175`) | **Copy** |
| Env-key pre-detection | **Copied (batch 2)**: row `3` detects a set anthropic variable and skips the paste (`wizard.ts:484-493`) | Detects the variable and pre-fills, clears on first keystroke (`auth.rs:710-718`, `:786-796`) | **Copied**; the names come from the registry, not a copy (`presentEnvKeys`, `wizard.ts:302-305`) |
| A machine with a subscription and nothing else | **Fixed in batch 1** (`interactive.ts:466-471`, notice at `:2001-2007`): the session mounts and names what is missing | Signed in is a normal state; onboarding simply hides | **Copied (batch 1)** — this was the largest single gap |
| Import from another agent | 20 sources, a full dry-run report, and a question-by-question wizard — but only behind `/yoshi` / `labunbun yoshi` | `/import` on explicit command only, never auto-offered; one startup tip is the only advertisement (`slash_dispatch.rs:538-541`; §7) | **Copy the discovery idea, go one step further**: offer the import directly in the first-run wizard, keep our engine |
| What the first frame says | Empty transcript and a placeholder (`PromptInput.tsx:163`); a credential-less start now gets the one Screen F line (batch 1) | Welcome line, then one rotating tip under a whole-corpus asset | **Copy the idea, not the volume** — see below |
| Project trust | Repo-shipped agents/skills held back with a notice naming `/agents` (`project-trust.ts:90-108`), and — inside a repository — naming the root above the decision's reach (`:125-135`) | A blocking per-directory question with a git-root rule (`trust_directory.rs:69-152`) | **Partly copied (batch 4)**: the notice gained Codex's git-root sentence, adapted to this app's cwd-scoped trust; the blocking prompt still is not copied, and our scope stays narrower (see below) |
| Updates | No updater in the tree | Startup update screen with skip/snooze, release builds only (`update_prompt.rs:203-269`) | Not applicable |
| Diagnostics at the failure | Used to print `fail — none of … set` even when signed in; the row now names each subscription (`doctor.ts:133-144`) | n/a | Fixed (batch 1) |

### What not to copy, and why

- **The full-screen welcome animation.** Codex owns its whole viewport; our transcript is the terminal's scrollback and the frame must stay below viewport height, so anything that grows the frame risks a clear-and-reprint on every keystroke (`docs/dev/split-pane-design.md`, "The frame, and its ceiling"). A one-line greeting is the affordable version.
- **The desktop-app / announcement promotion path** (`tooltips.rs:24-27`, `:70-81`) and the telemetry around it. It is advertising machinery for a product with a desktop app, and the announcement fetch adds a network dependency to the first screen.
- **Quitting when the auth step is cancelled** (`onboarding_screen.rs:359-364`). Codex has one product surface; we have `-p`, ACP servers and editor sessions. Exiting on Esc turns "I'll decide later" into "the app is broken". Our equivalent is to mount and say what is missing.
- **Bedrock, GovCloud guidance and workload identity** — enterprise doors with no counterpart here.
- **`--with-api-key` reading a key from stdin** (`login.rs:281-287`) is a fine idea, but the wizard's masked reader (`wizard.ts:250-295`) already covers the interactive case, and a non-TTY `labunbun login --with-api-key` would be a new credential path to secure. Leave it out of this wave.
- **The trust prompt as a blocking gate.** Our definitions gate is scoped to `~/.labunbun/agents` and `~/.labunbun/skills` inside the project (`project-trust.ts:1-29`), and it already fails closed with a visible notice; Codex's prompt exists because its trusted folders can execute code on load. The git-root *wording* landed in batch 4 on the notice instead of a prompt — adapted, because Codex's sentence names the repository root as what its trust covers and this app's trust covers exactly the cwd; the prompt itself is still not copied.

## 4. Proposed OOBE flow for labunbun

Three surfaces: the pre-REPL console flow (extended `wizard.ts`), the first REPL frame (one info line), and a one-shot re-offer recorded in the user settings. Everything below is built from mechanisms that already exist or need only wiring.

### Screen A — detection block (console, before any question) — implemented (batch 2)

Keep `wizard.ts:421`'s header, add what the machine already knows (built at `wizard.ts:430-442`; rows from `wizardDetectionLines`, `wizard.ts:197-207`):

```
Welcome to labunbun — first-time setup. Press Enter to accept [defaults].
Project directory: G:\Bunttta\labunbun

Found on this machine:
  Claude Code    ~/.claude            18 projects, 4 MCP servers, 12 skills
  Codex          ~/.codex
  Environ        ANTHROPIC_AUTH_TOKEN is set
```

- Sources and labels: `detectSources(home)` + `MIGRATION_SOURCE_LABELS` (`migrate-types.ts:82-103`, `:234-236`); counts per source already exist in `listHistory` / the raw reads the plan uses.
- The `Environ` row is `/doctor`'s computation, hoisted (`doctor.ts:128-144`) — batch 1 extended it to the credential stores, which is what keeps it from reporting "nothing" on the machine this flow exists for.
- The block is printed only when it is non-empty; silence is the app's existing habit (`interactive.ts:2017-2019`).

### Screen B — how do you want to pay for it (question 1, replaces the current provider question) — implemented (batch 2)

```
How do you want to use labunbun?
  1. Sign in with a Claude subscription      a browser opens; no API key needed
  2. Sign in with a ChatGPT subscription     the ChatGPT models, on your plan
  3. Use an API key                          paste it now, or export it yourself
  4. Use an OpenAI-compatible endpoint       DeepSeek, Kimi, GLM, a local daemon
[1]:
```

- The list is ordered the way Codex orders its picker (`auth.rs:494-520`) and the default is the row that is true for this machine: `1` when a Claude config is detected, `3` when a known key variable is already set, otherwise `1` (`wizardProviderDefault`, `wizard.ts:180-186`). Codex's default rule is the same shape (`onboarding_screen.rs:169-175`).
- `1` calls `runClaudeLoginCli`'s flow (`claude-login.ts:161-210`) with the terminal's `askCode` (`claude-login.ts:261-278`) — it is console-native already. `2` calls `chatGptLoginFlow` (`chatgpt-login.ts:124-166`), whose fallback is the device code, so a machine with no reachable loopback still finishes. Built as the dispatch at `wizard.ts:475-482`; a failure returns non-zero and the wizard continues with a retry line.
- `3` with a variable already set skips the paste and says so, in Codex's wording (`auth.rs:710-718`); otherwise it uses the existing masked reader (`wizard.ts:250-295`). Built at `wizard.ts:484-493`; the detected names are the row's own env names, resolved through the registry (`detectedAnthropicEnv`, `wizard.ts:312-315`).
- `4` is today's `openai-compatible` branch, unchanged (`wizard.ts:494-508`).

### Screen C — import offer (question 2, only when Screen A found something) — implemented (batch 2), run after the write

```
Import your Claude Code setup? Settings, MCP servers, skills and this project's
conversations. You will see the full plan before anything is written. [Y/n]:
```

- `Y` runs `runMigration({ only: ["settings", "assets"], from: <detected sources>, home, cwd })` — the dry run — prints `result.report` (`main.ts:321-337` shows the exact shape), and then reuses the wizard's own confirm wording: `Apply these N file(s)?` with `Apply` / `Cancel` (`migrate-wizard.ts:302-311`). `--force` stays off, so nothing already present is overwritten (`docs/dev/migration-framework.md`).
- History stays out of the first-run offer by default: it is the slowest category and the one with the least claim on a first launch. `/yoshi` keeps offering it (`migrate-wizard.ts:161-247`).
- **Implemented after the write, not before** (the heading's "question 2" is the design's order, not the built one). The dry run's `Apply these N file(s)?` must count the tree the apply will actually meet: with the wizard's answers already on disk and `--force` off, `claimScalar` skips every key the wizard wrote — the confirm is over the real plan, and the import can add but never clobber. The built question also drops the sketch's "and this project's conversations": history is the one category this offer omits, and a question must not promise what its plan will not count (`importOfferLine`, `wizard.ts:219-223`; the offer at `wizard.ts:329-381`, called at `wizard.ts:540`).
- The console path cannot use `askUser`; it asks with `askChoice` (`wizard.ts:235-248`) and prints what the wizard would have printed. The scripted path (`/yoshi`, `labunbun yoshi`) is untouched.

### Screen D — the questions that already exist — implemented (batch 2)

Theme and editing model stay as they are (`wizard.ts:513-517`), with the change taken: the default is `auto` (`wizard.ts:161`) now that the terminal probe exists (`detect-appearance.ts:1-13`), and `"auto"` is an accepted answer (`wizard.ts:153`).

### Screen E — the write, and the skip rule — implemented (batch 2)

- Success keeps the write and its line (`wizard.ts:533-537`). Cancel keeps the `{}` write (`wizard.ts:560-567`) and loses the last clause of the old text: the repair now reads `Setup skipped — the session starts anyway. Run /login or /yoshi in it, or edit ~/.labunbun/settings.json.` (`wizard.ts:565-566`) — and the run continues into the REPL, which is the no-exit rule in its final form.
- Every question defaults on Enter; every question can be cancelled; the file is still written once at the end. The rule: **no answer may leave a state the app refuses to start in.** If the flow ends with no credential at all, the settings file is written with whatever was chosen and the REPL mounts anyway (Screen F). A throw after the write (the import half) leaves the file standing rather than blanking it (`wizard.ts:556-560`).
- Ctrl+C during a sign-in is handled by the flows themselves (`claude-login.ts:182-185` throws `The sign-in was cancelled.`; `runClaudeLoginCli` catches it and returns non-zero), so the wizard continues instead of aborting — the non-zero branch at `wizard.ts:480-483`.

### Screen F — the first REPL frame — implemented (batch 1)

The frame starts empty (`interactive.ts:1720`, `PromptInput.tsx:163`). Batch 1 adds one `pushInfo` line when — and only when — the session starts without a usable credential for its model:

```
No credential for anthropic/claude-sonnet-5 yet — the first prompt will fail. /login to sign in, or /yoshi to import a setup.
```

- `pushInfo` is the existing in-transcript startup channel (`interactive.ts:1976-1993`); the notice lands at `interactive.ts:2001-2007`, and the store probe runs only when the environment cannot already answer.
- The line names two commands; batch 3 added it to `help-commands.test.ts`'s advice list, so that test now holds it (both wires that draw on a login, anthropic and ChatGPT).
- When a credential resolves, say nothing. The app's rule is already "an unasked-for line on every startup is how a feature becomes noise" (`interactive.ts:2017-2019`).
- The gate is gone — it lived at `interactive.ts:433-436` before batch 1; `:466-471` is the comment in its place. The session mounts and warns instead of exiting. Headless and ACP keep failing fast — a `-p` run has no transcript to warn into, and the request-time error already names the variable.

### Screen G — the one-shot record — implemented (batch 3)

`wizard.ts` writes one key in the user settings, `firstRun: { offeredAt, signedIn, imported }`, through the existing read-merge-write (`packages/coding-agent/src/user-settings.ts:15-19`). `offeredAt` is the ISO instant of the write; `signedIn` is the state at the end of the run — a row-1/row-2 sign-in that finishes flips its flag — and `imported` says an apply ran, not how many files landed (under the merge rules "two files" and "none needed" are the same verdict). The write carries its own `try`: the wizard's outer catch reads any throw after the settings write as a failed import, and a failed note is not that.

One deviation from this sketch, noted because it reverses it: the record is **written but never read**. The sketch had it answering "should the notice in Screen F appear at all". Batch 3 decided against that — the notice stays condition-driven. A record is a log of one past run, a sign-in can expire or be revoked, and a record consulted as a suppressor would hide the notice exactly where it has just become true again. Screen A also stays condition-driven like Codex's (`lib.rs:2362-2386`), so a user who signs out sees the offer again. The record's remaining job is diagnostic.

## 5. Open decisions

1. **Where the first-run flow lives.** Keep it in the pre-REPL console wizard, or move it into the mounted REPL where `askUser` / `pickFromList` dialogs exist (`migrate-wizard.ts:37-42`)?
   *Recommendation:* keep it pre-REPL. It must run before `loadSettings` (`interactive.ts:399-402`) because it writes the file those settings come from, and a mounted REPL would need a session with no model. *Tradeoff:* the wizard is a second UI that cannot reuse ink, so it stays plain-text and has to be tested by driving readline.
2. **Does a missing key still stop the interactive start?**
   *Recommendation:* no. Mount, warn once (Screen F), let `/login`, `/model` and `/yoshi` work. *Tradeoff:* a typo in `--model` now costs a failed first prompt instead of an early exit — but the early exit is currently the first thing a paying subscriber sees.
3. **Should a sign-in write `model`?** A ChatGPT sign-in with the default `anthropic/claude-sonnet-5` (`interactive.ts:447`) still fails on the first prompt.
   *Recommendation:* yes, for the ChatGPT flow only — write a chatgpt row, because that credential is useless with any other model. *Tradeoff:* `login` starts editing settings, which is a new side effect for a command whose whole job was the credential; the alternative is a louder Screen F that tells the user to run `/model`.
   *Landed so far:* the wizard half, in batch 2 — the first-run ChatGPT row puts `chatgpt/gpt-6-astra` in the file it writes. The in-session `/login chatgpt` still does not touch `model` (no login flow calls `persistModelChoice`, whose only caller is `/model` at `interactive.ts:1583`), so a default-model session that signs in this way still fails its first prompt until `/model`. A residual gap, here so it is not rediscovered as a bug.
4. **How far may the first-run import go on its own?**
   *Recommendation:* dry run always, then one confirm over the whole plan, `settings` + `assets` only, `--force` off. *Tradeoff:* more keystrokes than Codex's checkbox screen, and a user who says yes still has to read a report before anything lands. The alternative — auto-apply when exactly one source is detected — is the one path that can silently change a working configuration.
5. **Project trust: prompt or notice?** We hold back repo-shipped agents/skills and say so (`project-trust.ts:90-108`); Codex blocks with a question and a git-root rule (`trust_directory.rs:69-152`).
   *Recommendation:* keep the notice, and adopt only the git-root sentence when a definition is actually withheld in a subdirectory of a repository. *Tradeoff:* less friction and less safety than Codex; the withheld notice is already visible and names the command, which is the property Codex's prompt buys.

## 6. Implementation sketch

Four batches. Line counts are rough, and no batch should be started before the decisions above are settled — they were settled on 2026-10-14 by taking each recommendation.

### Batch 1 — a machine with a subscription is a working machine — implemented (`149c620`; ~245 lines + ~275 test)

- New `packages/coding-agent/src/credential-presence.ts`: one rule answering "may this model run here" — `modelMayRun`, the sync mirror of the request path's check (the sign-ins arrive as values because the beetle band spawns in its constructor and cannot await) — consulting the environment (`resolveApiKey`, `packages/ai/src/model.ts:1624-1630`), the two credential stores (`claude-auth.ts:104-151`, `chatgpt-auth.ts`), and the empty-env-var rule (`packages/ai/src/index.ts:305-310`); plus the wording it drives, `unrunnableSuffix` per wire and `missingCredentialNotice`, and `requestPathPermits` — the request path's own `missingApiKey` call as a boolean — which `/model`'s switch guard and the band's `canRunModel` both read, so neither can drift from the shape a request sends. The store probe (`detectSubscriptionSignIns`) is async, because the keychain read is.
- `interactive.ts:466-471`: the gate is gone; the notice lands at `:2001-2007` — this is Screen F, landed early.
- `doctor.ts:133-144`: the Auth row reports a sign-in by name (never the value).
- `interactive.ts:3075-3096` and `:1660`, and the beetle picker (`beetle.ts`, `beetle-commands.ts`): all annotate through the same helper.
- Tests: `credential-presence.test.ts` pins the rule matrix and the notice wording; `startup-credential-notice.test.ts` mounts the real REPL in a subprocess with the provider environment stripped (exit 0 plus the exact line); `doctor.test.ts` gains the signed-in Auth rows. The seams — `InteractiveOptions.signIns`, `PickBeetleModelsOptions.signIns`, `runDoctorChecks`' tail parameter — keep every test off the real keychain.

### Batch 2 — the wizard grows up — implemented (`9403213`; ~300 lines + ~90 test)

- `wizard.ts`: the detection block (Screen A), the four-way provider question (Screen B), the import offer (Screen C), theme default `auto` (Screen D), and the no-exit skip rule (Screen E).
- Reuses: `detectSources`, `runMigration` (`migrate.ts`), `runClaudeLoginCli`'s flow and `chatGptLoginFlow` (`claude-login.ts:161-210`, `chatgpt-login.ts:124-166`), `askChoice` / `readMasked` (`wizard.ts:235-295`).
- `buildWizardSettings` (`wizard.ts:97-142`) gains the model implied by a sign-in — `chatgpt/gpt-6-astra` for the ChatGPT row, pinned against `listModels()` in the tests.
- Tests: `wizard.test.ts` already asserted the trigger and the translation; batch 2 added the chatgpt→settings mapping, the registry pin, the provider-default rule, the detection rows, and "import offer is absent when nothing is detected".
- Deviations from this sketch, both noted in place: the import offer runs after the settings write (§4 Screen C), and the trigger stays the file check — the condition-driven re-offer from §3's verdict row is not built; the sync pre-settings gate and the whole-file write would need a merge story first.

### Batch 3 — the first frame and the one-shot record — implemented (`64b62c1`; ~60 lines + ~55 test)

- `interactive.ts`: the Screen F `pushInfo` — **landed early with batch 1**; what remains for this batch is its `help-commands.test.ts` row below.
- `wizard.ts`: the `firstRun` record (Screen G) — the pure `firstRunRecord({ signIns, imported, now })` plus the write through `writeUserSettingsPatch` (`user-settings.ts:15-19`), in its own `try` so a failed note cannot read as a failed import. `offerImport` now returns whether an apply ran; the run tracks the post-login sign-in state for the record.
- `help-commands.test.ts`: the new advice lines join the list that must name real commands — both wires the credential notice can name a login on. The scan regex needed a path-separator guard (`(?<![\w/])`): the notice names its model as `provider/id`, whose tail scanned as a command.
- Docs: README's installation section gains the wizard-first path; `docs/dev/migration-framework.md` points here for the first-run offer.
- Deviations from this sketch, noted in place: the record is written but deliberately never read — the Screen F notice stays condition-driven (§4 Screen G) — and `imported` records that an apply ran, not how many files landed.

### Batch 4 — the trust sentence, gated — implemented (`b081003`; ~50 lines + ~70 test)

- `project-trust.ts`: `enclosingRepositoryRoot` (`:125-135`), and `withheldDefinitionNotice` (`:90-108`) gains the optional third argument; the callers (`interactive.ts`, `headless.ts`) pass the helper's answer, so the sentence appears exactly when a definition is actually withheld inside a repository.
- New helper: resolve the enclosing repository root. Nothing in the tree did this before — `GLOB_SKIP_DIRS` and the containment lists only mention `.git` as a name to avoid (`packages/tools/src/glob.ts:11`, `packages/tools/src/containment.ts:87`). The walk starts above the cwd (a session at a repository root gets nothing; nested repositories report the inner root), `.git` counts as a file too, and the path is built from the cwd's own spelling — no `realpath` — which is what keeps the `/var`-vs-`/private/var` spelling-trap class out of it.
- Deviations from this sketch, noted in place: the sketch's premise — "when a withheld tier lives above the working directory" — does not hold; the loaders read `join(cwd, ".labunbun", …)` and nothing walks up, so the sentence is about the repository root above the working directory, not a tier above it. And the sentence states this app's scope ("approval covers this directory, not the repository root at …") rather than Codex's claim, because Codex's trust is root-keyed where this app's ledger is keyed by the cwd.

### Tests that hold these claims

| Claim | Held by |
| --- | --- |
| The wizard runs only on a TTY, only with no settings file, and never again after a cancel | `packages/coding-agent/test/wizard.test.ts` |
| Every command a startup notice names is dispatchable | `packages/coding-agent/test/help-commands.test.ts` |
| The first-run record is stamped from one instant and both final sign-in states | `packages/coding-agent/test/wizard.test.ts` |
| The repository root above the cwd is found, or correctly absent | `packages/coding-agent/test/project-trust.test.ts` |
| `/doctor`'s auth row reflects what the machine holds | `packages/coding-agent/test/doctor.test.ts` |
| `/login` and `/logout` reach the real flows through the REPL | `packages/coding-agent/test/claude-commands.test.ts`, `chatgpt-commands.test.ts` |
| A migration wizard answers nothing until the user answers | `packages/coding-agent/test/migrate-wizard.test.ts` |
| A signed-in machine starts (batch 1) | `packages/coding-agent/test/credential-presence.test.ts` (the rule), `startup-credential-notice.test.ts` (the real REPL, provider env stripped), `doctor.test.ts` |
