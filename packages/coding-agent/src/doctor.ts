/**
 * /doctor diagnostics: environment health checks for shell, ripgrep,
 * auth, and settings.
 */
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
	DEFAULT_MODE_CHOICE,
	DEFAULT_SANDBOX_FOR_MODE,
	needsNetworkProxy,
	networkConfinementReason,
} from "@labunbun/agent";
import { apiKeyEnvNames, listModels } from "@labunbun/ai";
import {
	detectNativeBackend,
	detectShell,
	networkConfinement,
	type SandboxBackend,
	sandboxBackendFor,
} from "@labunbun/tools";
import { AUTO_THEME_NAME, DEFAULT_THEME, resolveBuiltInTheme } from "@labunbun/tui";
import type { SubscriptionSignIns } from "./credential-presence.ts";
import { changedBindings, type PadConfig } from "./gamepad-runtime.ts";
import { loadOutputStyles, resolveOutputStyle } from "./output-styles.ts";
import { networkAxisFrom, type Settings } from "./settings.ts";
import { loadThemeFiles, resolveTheme } from "./theme-file.ts";

export interface DoctorCheck {
	name: string;
	status: "ok" | "warn" | "fail";
	detail: string;
}

/**
 * The command paths this repo starts without handing them a sandbox policy.
 *
 * A policy is what buys a command two things: the wrapper `sandbox-exec` /
 * `bwrap`, and the proxy variables, which `Operations.exec` injects only when it
 * is given one. Every other spawn in this repo goes straight to `spawn` or to a
 * transport, so it gets neither — and on a native backend, where the row below
 * is `ok` because the OS denies a *sandboxed* command every route, these paths
 * are outside even that.
 *
 * This list held three entries; two left it. The `!` prompt prefix went first
 * (it now goes through the permission engine and is handed the workspace policy
 * like the Bash tool). Hooks and MCP stdio servers went second, through
 * `spawn-confinement.ts`: their spawns are re-parented under the same wrapper
 * the Bash tool uses, and the policy's proxy increment rides the environment.
 * What remains is the HTTP MCP transport, and it remains because there is no
 * spawn to confine — its traffic is this process's own, and this process is not
 * sandboxed.
 *
 * The list is exported rather than inlined into the sentence because a sentence
 * is the cheapest thing in the repo to leave stale: nothing fails when a path
 * here stops being true. `doctor.test.ts` reads each file named below and
 * fails the moment it stops being unwired, so the sentence cannot quietly
 * outlive the code it describes.
 */
export const COMMAND_PATHS_WITHOUT_SANDBOX = ["MCP HTTP servers"] as const;

/**
 * `home` and `liveThemeName` are the two things this cannot read off `settings`:
 * where the user's files are (a session may be pointed at another home), and
 * which theme is on screen right now (`/theme` may have changed it since
 * startup). Both default to the setting-based answer, which is right for a
 * caller that has neither.
 *
 * `pad` is the third, and it is passed rather than derived: the bindings a user
 * can actually press are the ones the running session resolved against the
 * command table, and resolving them a second time here — from the same settings
 * but without the command names — would let `/doctor` call a binding fine that
 * `/gamepad` calls unreadable. The runtime is built before the REPL mounts, so
 * the caller always has it.
 *
 * `platform` is the fourth, and for the same reason: the network row is a
 * statement about what can back a restriction up *on this machine*, so a test
 * running anywhere has to be able to ask the question about both. Defaults to
 * the real one, which is what a caller with no opinion wants.
 *
 * `hasNativeBackend` is the fifth, and it is a seam rather than an answer. The
 * row asks whether the platform's sandbox program is *installed*, which on Linux
 * is a PATH scan and on Windows is always false — so a test that passed only
 * `platform` would be asserting against whatever this machine happens to have,
 * and the "Linux without bubblewrap" case would be reachable only on a Linux box.
 * Probing for real is still the default, because that is the honest question to
 * ask in production; a test that wants the case says which one it means.
 *
 * `signIns` is the eighth, and like `hasNativeBackend` it is a seam rather than
 * an answer: whether a subscription is signed in is a keychain question no
 * environment read can settle, and a test must not ask the real one — the
 * operator's own sign-in would flip the Auth row and the test would pass or
 * fail by machine. A caller with the answer (the REPL, which reads it live)
 * passes it; without one the row reports the environment only, which is
 * exactly what it reported before this parameter existed.
 *
 * `sandboxBackend` and `appContainerReason` are the ninth and tenth, and they
 * are the session's own answer to what backs the sandbox — the same pair
 * `/permissions` prints. Without them the Network row recomputes the backend
 * from `platform` alone, which on Windows answers `simulated` for every
 * machine — including the ones whose container is selected, where
 * `/permissions` says the OS is enforcing it. One runtime, two answers; the
 * row must not be the one that disagrees. `hasNativeBackend` stays behind them
 * because it is the machine question for the platforms whose backend is an
 * argv prefix rather than a spawn-time selection.
 */
export async function runDoctorChecks(
	settings: Settings,
	cwd: string,
	home = homedir(),
	liveThemeName?: string,
	pad?: PadConfig,
	platform: string = process.platform,
	hasNativeBackend?: boolean,
	signIns?: SubscriptionSignIns,
	sandboxBackend?: SandboxBackend,
	appContainerReason?: string,
): Promise<DoctorCheck[]> {
	const checks: DoctorCheck[] = [];

	// Runtime
	checks.push({
		name: "Runtime",
		status: "ok",
		detail: `Bun ${Bun.version} · Node ${process.version} · ${process.platform}`,
	});

	// Shell availability (PowerShell on Windows, bash elsewhere)
	const shell = detectShell();
	checks.push({
		name: "Shell",
		status: shell.kind === "cmd" ? "warn" : "ok",
		detail:
			shell.kind === "cmd"
				? "cmd.exe fallback — no PowerShell was found; set LBB_SHELL_PATH to the shell the session should run"
				: `${shell.command} (${shell.kind === "powershell" ? "PowerShell" : "POSIX"})`,
	});

	// ripgrep presence (informational; Grep has a JS fallback)
	let rgStatus: DoctorCheck["status"] = "warn";
	let rgDetail = "not found — using built-in JS search";
	try {
		const proc = Bun.spawnSync(["rg", "--version"], { stdout: "pipe", stderr: "pipe" });
		if (proc.exitCode === 0) {
			rgStatus = "ok";
			rgDetail = proc.stdout.toString().split("\n")[0].trim();
		}
	} catch {
		// keep warn
	}
	checks.push({ name: "ripgrep", status: rgStatus, detail: rgDetail });

	// Auth: which API keys are visible. Read off the registry rather than copied
	// out of it, because a hand-kept list of the same names is a list that goes
	// stale silently: it was already missing `MINIMAX_API_KEY` while five built-in
	// rows read it, so a machine whose only key was MiniMax's was told it had none.
	// Nothing here is secret — the names are the whole point — and `listModels`
	// covers custom providers too, which is the other half of what a user can hold.
	const keys = [...new Set(listModels().flatMap((model) => apiKeyEnvNames(model)))].sort();
	const present = keys.filter((k) => process.env[k]);
	// A sign-in is a credential the environment cannot show, and a row that only
	// listed variables called a signed-in machine's Auth a failure. The caller
	// supplies the answer when it has one (the REPL reads it live).
	const signedIn = [
		...(signIns?.claude ? ["Claude subscription"] : []),
		...(signIns?.chatgpt ? ["ChatGPT subscription"] : []),
		...(signIns?.gemini ? ["Gemini subscription"] : []),
	];
	checks.push({
		name: "Auth",
		status: present.length > 0 || signedIn.length > 0 ? "ok" : "fail",
		detail:
			present.length > 0 || signedIn.length > 0
				? [...present, ...signedIn].join(", ")
				: `none of ${keys.join(", ")} set`,
	});

	// Model resolution
	checks.push({
		name: "Model",
		status: settings.model ? "ok" : "warn",
		detail: settings.model ?? "default (anthropic/claude-sonnet-5) — set `model` in settings.json",
	});

	// Settings files present
	const userSettings = join(home, ".labunbun", "settings.json");
	const projectSettings = join(cwd, ".labunbun", "settings.json");
	const found = [userSettings, projectSettings].filter((p) => existsSync(p));
	checks.push({
		name: "Settings",
		status: found.length > 0 ? "ok" : "warn",
		detail: found.length > 0 ? found.join(", ") : "no settings files (all defaults)",
	});

	// Output style: `settings.outputStyle` names a file, so a name that matches
	// nothing injects nothing — a typo that is invisible until the prompt fails to
	// change. This row is where it becomes visible, the same way the Theme row
	// reports a name that resolves to no theme.
	//
	// Read through `loadOutputStyles`, not by listing the directory here: that
	// loader is where the project tier is held behind the one-time trust decision,
	// so a row that enumerated files itself could call a repository's style
	// "found" in a session that would never load it.
	const styles = loadOutputStyles(cwd, home);
	const styleName = settings.outputStyle;
	if (!styleName) {
		checks.push({ name: "Output style", status: "ok", detail: "none selected" });
	} else {
		const style = resolveOutputStyle(styleName, styles);
		checks.push(
			style
				? {
						name: "Output style",
						status: "ok",
						detail: `${style.name} (${style.source}) — ${style.sourcePath}`,
					}
				: {
						name: "Output style",
						status: "warn",
						detail:
							styles.length > 0
								? `no style named "${styleName}" (available: ${styles
										.map((s) => s.name)
										.sort()
										.join(", ")})`
								: `no style named "${styleName}" (no styles in ~/.labunbun/output-styles)`,
					},
		);
	}

	// The network axis, and specifically whether this machine can back it up.
	//
	// `/permissions` reports the axis as the session holds it, which is the right
	// answer to "what may this session reach". This row answers the other
	// question — "is that restriction real here" — which is a property of the
	// machine rather than of the session, so it cannot be read off it.
	//
	// Both facts this row needs come from the same functions `/permissions` uses,
	// which is the only way two surfaces stop disagreeing. It used to ask
	// `platform === "darwin" || platform === "linux"`, which is a different question
	// and the wrong one: it said `ok` on a Linux box with no bubblewrap, while
	// `/permissions` on the same session said the backend was missing. A `warn` is
	// the only signal this row gives, and it was staying green on the machine that
	// needed it.
	//
	// The wording is `describeNetworkPolicy`'s, for the same reason — and it matters
	// that the native case is *not* "the proxy, with the OS holding the rest",
	// because "the rest" is not what the kernel denies. On each platform the
	// kernel denies every route off the machine and leaves exactly one standing —
	// macOS the proxy's own loopback ports, Linux the namespace's loopback bridge
	// to them — so the allowlist does govern a shell, through the route the row
	// names. This row says which shape it is rather than averaging them.
	const axis = networkAxisFrom(settings);
	if (needsNetworkProxy(axis.access, axis.domains)) {
		const allowCount = axis.domains.filter((rule) => rule.permission === "allow").length;
		const reach =
			axis.access === "restricted"
				? allowCount === 0
					? "nothing is reachable"
					: `${allowCount} domain${allowCount === 1 ? "" : "s"} allowed`
				: `${axis.domains.length} pattern${axis.domains.length === 1 ? "" : "s"} denied`;
		// The session's own backend when the caller has one — the same value
		// `/permissions` hands `describeSandboxBackend` — and the machine question
		// only without it. Recomputed from `platform` alone this said `simulated`
		// on Windows in sessions where the container had been selected, which is
		// the disagreement the parameter exists to end.
		const backend = sandboxBackend ?? sandboxBackendFor(platform, hasNativeBackend ?? detectNativeBackend(platform));
		// The pairing, not just the setting: an unset `sandbox` resolves through
		// `DEFAULT_SANDBOX_FOR_MODE`, which is how the session resolves it too. Every
		// mode currently pairs to `workspace-write`, so this is not a place where
		// three answers collapse into one by accident — it is the same resolution the
		// app runs, stated once.
		const sandbox = settings.sandbox ?? DEFAULT_SANDBOX_FOR_MODE[settings.permissionMode ?? DEFAULT_MODE_CHOICE.mode];
		const confinement = networkConfinement(backend, sandbox, axis.access, platform);
		// `ok` is reserved for the cases where the kernel, not the program, is what
		// holds the boundary: under `proxy-ports` the kernel leaves exactly one
		// route standing — the enforcing proxy's own loopback ports — and under
		// `proxy-bridge` exactly one route takes their place — the namespace's
		// loopback bridge into the proxy — so in both cases the restriction holds
		// in the kernel and the allowlist still governs a shell, through that one
		// route; the detail says which route it is.
		//
		// The other four all warn, and the *reason* is in the row rather than left to
		// `/permissions`: "the proxy is the whole boundary" on its own tells a user
		// they have a problem without telling them which one they have, and the
		// causes are different things — a build with no backend for the platform, a
		// package they can install, a machine whose Windows container was not
		// selected (the probe's own why travels in for that one), or a setting they
		// wrote. Read off the same function `describeNetworkPolicy` uses, so the two
		// surfaces cannot drift apart.
		const kernelHoldsIt = confinement === "proxy-bridge" || confinement === "proxy-ports";
		// Only the `ok` row needs the correction, and it needs it because it is the
		// one that over-claims: "shell traffic goes through the proxy" is a
		// statement about a command that went through the Bash tool and was handed
		// a policy; the path below is never handed one — there is no spawn to
		// confine, its traffic is this process's own — so on this machine it is the
		// one that can still reach the network. The two `warn` rows are already
		// hedged by the "a program that ignores HTTP_PROXY… is not subject to it"
		// clause they carry, and a longer sentence does not make them more true.
		const uncovered = `, and ${COMMAND_PATHS_WITHOUT_SANDBOX.join(", ")} are started without one, so they are outside all of it`;
		const detail = kernelHoldsIt
			? axis.access === "restricted"
				? confinement === "proxy-ports"
					? `${axis.access} (${reach}) · the OS sandbox denies a command every route off the machine except the local proxy's own loopback ports, so shell traffic goes through the proxy and the allowed list governs both shell and web tools${uncovered}`
					: `${axis.access} (${reach}) · the OS sandbox denies a command every route off the machine except the loopback bridge into the proxy, so shell traffic goes through the proxy and the allowed list governs both shell and web tools${uncovered}`
				: `${axis.access} (${reach}) · a local proxy decides, and a program that ignores HTTP_PROXY/HTTPS_PROXY/ALL_PROXY is not subject to it`
			: `${axis.access} (${reach}) · ${networkConfinementReason(confinement, platform, backend, appContainerReason)} So the proxy is the whole boundary: a program that opens a socket without consulting HTTP_PROXY/HTTPS_PROXY/ALL_PROXY is not subject to it`;
		checks.push({ name: "Network", status: kernelHoldsIt ? "ok" : "warn", detail });
	} else {
		checks.push({
			name: "Network",
			status: "ok",
			detail: "not restricted — commands reach whatever the host can reach",
		});
	}

	// Theme resolution: an unresolved name or a broken theme file shows up as a
	// theme that silently did nothing, so it is worth naming here.
	//
	// The live choice rather than the one the session started with: /theme may
	// have changed it since, and a row naming the theme that was on screen an hour
	// ago is a row about a screen nobody is looking at.
	const themeName = liveThemeName ?? settings.theme ?? DEFAULT_THEME.name;
	const loadedThemes = loadThemeFiles(cwd, home);
	const known =
		themeName === AUTO_THEME_NAME || loadedThemes.themes.has(themeName) || resolveBuiltInTheme(themeName) !== undefined;
	// `auto` is the one choice that does not say what it resolved to, and saying
	// what it resolved to is the only thing this row is for. Resolved through the
	// same call the session uses, so a theme file that claims the detected
	// appearance is reported here exactly as it is applied — but never by taking
	// the keyboard back: `/doctor` runs with the REPL on screen, so it reads the
	// cached probe answer (or, in a session that never probed, the standing
	// environment) rather than standing stdin down for a fresh ask.
	const resolvedName =
		themeName === AUTO_THEME_NAME
			? (await resolveTheme(themeName, cwd, home, { allowProbe: false })).theme.name
			: themeName;
	const label = resolvedName === themeName ? themeName : `${themeName} → ${resolvedName}`;
	const themeDetails = [known ? label : `unknown theme "${themeName}" — using ${DEFAULT_THEME.name}`];
	if (loadedThemes.themes.size > 0) themeDetails.push(`${loadedThemes.themes.size} from theme files`);
	themeDetails.push(...loadedThemes.problems);
	checks.push({
		name: "Theme",
		status: known && loadedThemes.problems.length === 0 ? "ok" : "warn",
		detail: themeDetails.join(" · "),
	});

	// The controller: configuration only, never the hardware.
	//
	// Whether a pad is plugged in, and whether node-hid loaded at all, are runtime
	// facts that change while the user is looking at the screen — `/gamepad status`
	// answers those, and answers them about *now*. What can be checked here is the
	// part that is the same whether or not anything is plugged in: a binding that
	// names a button or an action that does not exist, which is a typo in a file
	// and is invisible until the button does nothing.
	const padEnabled = pad?.enabled ?? settings.gamepad?.enabled === true;
	const padDetails: string[] = [padEnabled ? "enabled" : "off — /gamepad on, or --gamepad for one run"];
	if (padEnabled) {
		if (pad?.allowApprove) padDetails.push("✕ may answer a permission dialog");
		if (pad?.device) padDetails.push(`device filter: ${pad.device}`);
		const changed = pad ? changedBindings(pad.bindings).length : 0;
		if (changed > 0) padDetails.push(`${changed} binding${changed === 1 ? "" : "s"} changed from the default`);
	}
	// Printed whether or not the pad is on: a binding that cannot be read is
	// precisely the thing that would make turning it on look like it did nothing.
	const padProblems = pad?.problems ?? [];
	padDetails.push(...padProblems);
	checks.push({
		name: "Gamepad",
		status: padProblems.length > 0 ? "warn" : "ok",
		detail: padDetails.join(" · "),
	});

	// Session storage writable
	try {
		const { mkdirSync, writeFileSync, rmSync } = await import("node:fs");
		const probe = join(home, ".labunbun", "projects", ".doctor-probe");
		mkdirSync(probe, { recursive: true });
		writeFileSync(join(probe, "probe"), "x");
		rmSync(probe, { recursive: true, force: true });
		checks.push({ name: "Session store", status: "ok", detail: "~/.labunbun/projects writable" });
	} catch (error) {
		checks.push({
			name: "Session store",
			status: "fail",
			detail: `cannot write ~/.labunbun: ${error instanceof Error ? error.message : error}`,
		});
	}

	return checks;
}

export function formatDoctorReport(checks: DoctorCheck[]): string {
	return checks
		.map((c) => {
			const icon = c.status === "ok" ? "✓" : c.status === "warn" ? "!" : "✗";
			return `${icon} ${c.name}: ${c.detail}`;
		})
		.join("\n");
}
