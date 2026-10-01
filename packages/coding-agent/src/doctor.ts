/**
 * /doctor diagnostics: environment health checks for shell, ripgrep,
 * auth, and settings.
 */
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DEFAULT_SANDBOX_FOR_MODE, needsNetworkProxy, networkConfinementReason } from "@labunbun/agent";
import { apiKeyEnvNames, listModels } from "@labunbun/ai";
import { detectNativeBackend, detectShell, networkConfinement, sandboxBackendFor } from "@labunbun/tools";
import { AUTO_THEME_NAME, DEFAULT_THEME, resolveBuiltInTheme } from "@labunbun/tui";
import { changedBindings, type PadConfig } from "./gamepad-runtime.ts";
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
 * The list is exported rather than inlined into the sentence because a sentence
 * is the cheapest thing in the repo to leave stale: nothing fails when a path
 * here stops being true. `doctor.test.ts` reads each file named below and
 * fails the moment it stops being unwired, so the sentence cannot quietly
 * outlive the code it describes.
 */
export const COMMAND_PATHS_WITHOUT_SANDBOX = [
	"hooks",
	"MCP stdio servers",
	"MCP HTTP servers",
	"the `!` prompt prefix",
] as const;

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
 */
export async function runDoctorChecks(
	settings: Settings,
	cwd: string,
	home = homedir(),
	liveThemeName?: string,
	pad?: PadConfig,
	platform: string = process.platform,
	hasNativeBackend?: boolean,
): Promise<DoctorCheck[]> {
	const checks: DoctorCheck[] = [];

	// Runtime
	checks.push({
		name: "Runtime",
		status: "ok",
		detail: `Bun ${Bun.version} · Node ${process.version} · ${process.platform}`,
	});

	// Shell availability (POSIX shell preferred for the Bash tool)
	const shell = detectShell();
	const isCmd = shell.command === "cmd.exe";
	checks.push({
		name: "Shell",
		status: isCmd ? "warn" : "ok",
		detail: isCmd ? "cmd.exe fallback — install Git for Windows for POSIX syntax" : `${shell.command} (POSIX)`,
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
	checks.push({
		name: "Auth",
		status: present.length > 0 ? "ok" : "fail",
		detail: present.length > 0 ? present.join(", ") : `none of ${keys.join(", ")} set`,
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
	// that the native case is *not* "the proxy, with the OS holding the rest". On a
	// native backend with a restricted network the OS denies the proxy as well, so
	// the proxy is not belt-and-braces here, it is simply unreachable from a shell.
	// This row says which of the two it is rather than averaging them.
	const axis = networkAxisFrom(settings);
	if (needsNetworkProxy(axis.access, axis.domains)) {
		const allowCount = axis.domains.filter((rule) => rule.permission === "allow").length;
		const reach =
			axis.access === "restricted"
				? allowCount === 0
					? "nothing is reachable"
					: `${allowCount} domain${allowCount === 1 ? "" : "s"} allowed`
				: `${axis.domains.length} pattern${axis.domains.length === 1 ? "" : "s"} denied`;
		const backend = sandboxBackendFor(platform, hasNativeBackend ?? detectNativeBackend(platform));
		// The pairing, not just the setting: an unset `sandbox` resolves through
		// `DEFAULT_SANDBOX_FOR_MODE`, which is how the session resolves it too. Every
		// mode currently pairs to `workspace-write`, so this is not a place where
		// three answers collapse into one by accident — it is the same resolution the
		// app runs, stated once.
		const sandbox = settings.sandbox ?? DEFAULT_SANDBOX_FOR_MODE[settings.permissionMode ?? "ask"];
		const confinement = networkConfinement(backend, sandbox, axis.access);
		// `ok` is reserved for the one case where nothing is holding the boundary but
		// the program itself: the OS denies every route, so the restriction holds
		// more completely than a proxy could manage. It costs the allowlist its
		// effect on a shell, and the detail says so rather than the status
		// pretending otherwise.
		//
		// The other four all warn, and the *reason* is in the row rather than left to
		// `/permissions`: "the proxy is the whole boundary" on its own tells a user
		// they have a problem without telling them which of three they have, and the
		// three are fixed by three different things — a build that ships no backend, a
		// package they can install, or a setting they wrote. Read off the same table
		// `describeNetworkPolicy` uses, so the two surfaces cannot drift apart.
		const kernelHoldsIt = confinement === "os-namespace";
		// Only the `ok` row needs the correction, and it needs it because it is the
		// one that over-claims. "A shell command reaches nothing" is a statement
		// about a command that went through the Bash tool and was handed a policy;
		// the four paths below never are, so on this machine they are the ones that
		// can still reach the network. The two `warn` rows are already hedged by the
		// "a program that ignores HTTP_PROXY… is not subject to it" clause they
		// carry, and a longer sentence does not make them more true.
		const uncovered = `, and ${COMMAND_PATHS_WITHOUT_SANDBOX.join(", ")} are started without one, so they are outside all of it`;
		const detail = kernelHoldsIt
			? axis.access === "restricted"
				? `${axis.access} (${reach}) · the OS sandbox denies a command every route off the machine, proxy included, so a shell command reaches nothing and the allowed list governs the web tools${uncovered}`
				: `${axis.access} (${reach}) · a local proxy decides, and a program that ignores HTTP_PROXY/HTTPS_PROXY/ALL_PROXY is not subject to it`
			: `${axis.access} (${reach}) · ${networkConfinementReason(confinement)} So the proxy is the whole boundary: a program that opens a socket without consulting HTTP_PROXY/HTTPS_PROXY/ALL_PROXY is not subject to it`;
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
	// appearance is reported here exactly as it is applied.
	const resolvedName =
		themeName === AUTO_THEME_NAME ? (await resolveTheme(themeName, cwd, home)).theme.name : themeName;
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
