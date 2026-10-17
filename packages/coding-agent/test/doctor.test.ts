import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describeSandboxBackend, type SandboxBackend } from "@labunbun/tools";
import { COMMAND_PATHS_WITHOUT_SANDBOX, formatDoctorReport, runDoctorChecks } from "../src/doctor.ts";
import { padConfigFrom } from "../src/gamepad-runtime.ts";
import { approveProjectDefinitions } from "../src/project-trust.ts";
import { SettingsSchema } from "../src/settings.ts";

/** This package's `src`, for the guards that read a call site out of a sibling. */
const SRC = join(import.meta.dir, "..", "src");

/**
 * The text around one call site: the anchor and the next 500 characters.
 *
 * A window rather than the whole file, because the claim being checked is about
 * *this* call — "this spawn is handed a policy" — and a whole-file check would
 * let a policy passed to some other call in the same file vouch for one that has
 * none. The assertion that the anchor was found at all lives in the caller: an
 * empty window would otherwise satisfy every "not.toContain" below it.
 */
function callSite(source: string, anchor: string): string {
	const at = source.indexOf(anchor);
	if (at < 0) throw new Error(`anchor not found in this file: ${anchor}`);
	return source.slice(at, at + 500);
}

/**
 * A throwaway home and cwd. The doctor probes the session store for write access
 * and reads theme files, so both have to be somewhere other than the operator's
 * own `~/.labunbun` — see isolation.test.ts.
 */
function makeDirs() {
	const root = mkdtempSync(join(tmpdir(), "lbb-doctor-"));
	const home = join(root, "home");
	const cwd = join(root, "project");
	mkdirSync(cwd, { recursive: true });
	return { home, cwd };
}

/** The Theme row's detail; every theme assertion is about this one line. */
function themeDetail(checks: Awaited<ReturnType<typeof runDoctorChecks>>): string {
	return checks.find((c) => c.name === "Theme")?.detail ?? "";
}

/** The Output style row's detail; a name that resolves to nothing has no other symptom. */
function styleDetail(checks: Awaited<ReturnType<typeof runDoctorChecks>>): string {
	return checks.find((c) => c.name === "Output style")?.detail ?? "";
}

/** The Gamepad row, which is two lines when a binding could not be read. */
function padRow(checks: Awaited<ReturnType<typeof runDoctorChecks>>) {
	return checks.find((c) => c.name === "Gamepad");
}

describe("runDoctorChecks", () => {
	test("produces a full report without throwing", async () => {
		const { home, cwd } = makeDirs();
		const settings = SettingsSchema.parse({});
		const checks = await runDoctorChecks(settings, cwd, home);
		const names = checks.map((c) => c.name);
		expect(names).toContain("Runtime");
		expect(names).toContain("Shell");
		expect(names).toContain("ripgrep");
		expect(names).toContain("Auth");
		expect(names).toContain("Session store");

		for (const check of checks) {
			expect(["ok", "warn", "fail"]).toContain(check.status);
			expect(check.detail.length).toBeGreaterThan(0);
		}
	});

	test("report formats with status icons", async () => {
		const { home, cwd } = makeDirs();
		const settings = SettingsSchema.parse({});
		const report = formatDoctorReport(await runDoctorChecks(settings, cwd, home));
		expect(report).toMatch(/[✓!✗] Runtime:/);
	});

	// A sign-in is a credential the environment cannot show; the row used to
	// call a signed-in machine's Auth a failure. The sign-ins are passed as a
	// value rather than asked of the real keychain — see the `signIns` parameter.
	test("a signed-in subscription makes the Auth row ok with no environment key", async () => {
		const { home, cwd } = makeDirs();
		const checks = await runDoctorChecks(
			SettingsSchema.parse({}),
			cwd,
			home,
			undefined,
			undefined,
			undefined,
			undefined,
			{ claude: true, chatgpt: true, gemini: true },
		);
		const auth = checks.find((c) => c.name === "Auth");
		expect(auth?.status).toBe("ok");
		expect(auth?.detail).toContain("Claude subscription");
		expect(auth?.detail).toContain("ChatGPT subscription");
		expect(auth?.detail).toContain("Gemini subscription");
	});

	test("with no sign-ins supplied the Auth row is the environment's row alone", async () => {
		const { home, cwd } = makeDirs();
		const checks = await runDoctorChecks(SettingsSchema.parse({}), cwd, home);
		expect(checks.find((c) => c.name === "Auth")?.detail).not.toContain("subscription");
	});

	// The probe writes a file to prove the directory is writable, and used to do
	// it in the operator's real home on every run.
	test("the session-store probe runs in the given home, and cleans up after itself", async () => {
		const { home, cwd } = makeDirs();
		await runDoctorChecks(SettingsSchema.parse({}), cwd, home);
		// A fresh temp home has no `.labunbun` at all, so its existence is proof
		// the probe went there rather than to the real one.
		expect(existsSync(join(home, ".labunbun", "projects"))).toBe(true);
		expect(existsSync(join(home, ".labunbun", "projects", ".doctor-probe"))).toBe(false);
	});

	test("theme files are read from the given home", async () => {
		const { home, cwd } = makeDirs();
		const themes = join(home, ".labunbun", "themes");
		mkdirSync(themes, { recursive: true });
		writeFileSync(join(themes, "midnight.json"), JSON.stringify({ name: "midnight", appearance: "dark" }));
		const detail = themeDetail(await runDoctorChecks(SettingsSchema.parse({ theme: "midnight" }), cwd, home));
		expect(detail).toBe("midnight · 1 from theme files");
	});

	// The session may have switched themes since it started; the row is about the
	// screen in front of the user, not about the one they booted into.
	test("a live theme name beats the one in settings", async () => {
		const { home, cwd } = makeDirs();
		const checks = await runDoctorChecks(SettingsSchema.parse({ theme: "dark" }), cwd, home, "light");
		expect(themeDetail(checks)).toBe("light");
	});

	test("an unknown live theme is reported as unknown", async () => {
		const { home, cwd } = makeDirs();
		const checks = await runDoctorChecks(SettingsSchema.parse({ theme: "dark" }), cwd, home, "ghost");
		expect(themeDetail(checks)).toContain('unknown theme "ghost"');
	});

	// "auto" is the one choice that does not say which theme is on screen, and
	// saying so is the entire content of this row.
	test("auto reports both the choice and what it resolved to", async () => {
		const { home, cwd } = makeDirs();
		const checks = await runDoctorChecks(SettingsSchema.parse({ theme: "auto" }), cwd, home, "auto");
		// No TTY here, so detection declines to probe and lands on dark.
		expect(themeDetail(checks)).toBe("auto → dark");
	});

	test("auto names the theme file it resolved to, not the built-in it replaces", async () => {
		const { home, cwd } = makeDirs();
		const themes = join(home, ".labunbun", "themes");
		mkdirSync(themes, { recursive: true });
		writeFileSync(join(themes, "midnight.json"), JSON.stringify({ name: "midnight", appearance: "dark" }));
		const checks = await runDoctorChecks(SettingsSchema.parse({ theme: "auto" }), cwd, home, "auto");
		expect(themeDetail(checks)).toBe("auto → midnight · 1 from theme files");
	});

	test("a broken theme file is reported on the theme row", async () => {
		const { home, cwd } = makeDirs();
		const themes = join(home, ".labunbun", "themes");
		mkdirSync(themes, { recursive: true });
		writeFileSync(join(themes, "broken.json"), "{ not json");
		const checks = await runDoctorChecks(SettingsSchema.parse({}), cwd, home);
		const theme = checks.find((c) => c.name === "Theme");
		expect(theme?.status).toBe("warn");
		expect(theme?.detail).toContain("broken.json");
	});
});

/**
 * The Output style row: `settings.outputStyle` names a file, and a name that
 * matches nothing injects nothing — no error, no change on screen. This row is
 * where the typo becomes visible, read through the same loader the session uses
 * so the project tier stays behind its trust decision.
 */
describe("the Output style row", () => {
	test("unset is ok and selects nothing", async () => {
		const { home, cwd } = makeDirs();
		const checks = await runDoctorChecks(SettingsSchema.parse({}), cwd, home);
		expect(checks.find((c) => c.name === "Output style")?.status).toBe("ok");
		expect(styleDetail(checks)).toBe("none selected");
	});

	test("an unknown name warns with the typo and the names that do exist", async () => {
		const { home, cwd } = makeDirs();
		const dir = join(home, ".labunbun", "output-styles");
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "concise.md"), "Be brief.");
		const checks = await runDoctorChecks(SettingsSchema.parse({ outputStyle: "consise" }), cwd, home);
		const row = checks.find((c) => c.name === "Output style");
		expect(row?.status).toBe("warn");
		expect(row?.detail).toContain('no style named "consise"');
		expect(row?.detail).toContain("available: concise");
	});

	test("a user-tier style is found, with its tier and path", async () => {
		const { home, cwd } = makeDirs();
		const dir = join(home, ".labunbun", "output-styles");
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "concise.md"), "Be brief.");
		const checks = await runDoctorChecks(SettingsSchema.parse({ outputStyle: "concise" }), cwd, home);
		const row = checks.find((c) => c.name === "Output style");
		expect(row?.status).toBe("ok");
		expect(row?.detail).toContain("concise (user)");
		expect(row?.detail).toContain(join(dir, "concise.md"));
	});

	test("an untrusted project's style is not reported as found", async () => {
		// The row reads through `loadOutputStyles`, so the project tier stays
		// behind the same one-time decision the session applies. Before approval
		// the style is withheld, and the row reports it the only way a withheld
		// style can be: absent. The approval at the end is the control — same
		// file, same setting, and the row flips only once the gate opens, so a
		// path this test never sees cannot pass it.
		const { home, cwd } = makeDirs();
		const dir = join(cwd, ".labunbun", "output-styles");
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "loud.md"), "LOUD.");
		const settings = SettingsSchema.parse({ outputStyle: "loud" });

		const before = (await runDoctorChecks(settings, cwd, home)).find((c) => c.name === "Output style");
		expect(before?.status).toBe("warn");
		expect(before?.detail).toContain('no style named "loud"');
		expect(before?.detail).toContain("no styles in ~/.labunbun/output-styles");

		approveProjectDefinitions(cwd, ["styles"], home);
		const after = (await runDoctorChecks(settings, cwd, home)).find((c) => c.name === "Output style");
		expect(after?.status).toBe("ok");
		expect(after?.detail).toContain("loud (project)");
	});
});

describe("the Gamepad row", () => {
	test("off by default, and the row says how to turn it on", async () => {
		const { home, cwd } = makeDirs();
		const row = padRow(await runDoctorChecks(SettingsSchema.parse({}), cwd, home));
		expect(row?.status).toBe("ok");
		expect(row?.detail).toBe("off — /gamepad on, or --gamepad for one run");
	});

	test("settings alone are enough to enable it", async () => {
		// The doctor runs before a session exists, so it reads the settings file and
		// not a live runtime — the two must agree, which is why the row's wording is
		// written from the resolved config either way.
		const { home, cwd } = makeDirs();
		const row = padRow(await runDoctorChecks(SettingsSchema.parse({ gamepad: { enabled: true } }), cwd, home));
		expect(row?.detail).toBe("enabled");
	});

	test("a live runtime reports approvals, the device filter and changed bindings", async () => {
		const { home, cwd } = makeDirs();
		const pad = padConfigFrom(
			SettingsSchema.parse({
				gamepad: { enabled: true, allowApprove: true, device: "wireless", bindings: { cross: "cancel" } },
			}),
		);
		const row = padRow(await runDoctorChecks(SettingsSchema.parse({}), cwd, home, undefined, pad));
		expect(row?.status).toBe("ok");
		expect(row?.detail).toBe(
			"enabled · ✕ may answer a permission dialog · device filter: wireless · 1 binding changed from the default",
		);
	});

	test("an unreadable binding warns, and is named", async () => {
		// The row is the one place a typo in `bindings` is visible without turning
		// the pad on, so the problem text has to survive into the detail.
		const { home, cwd } = makeDirs();
		const pad = padConfigFrom(SettingsSchema.parse({ gamepad: { enabled: true, bindings: { cros: "confirm" } } }));
		const row = padRow(await runDoctorChecks(SettingsSchema.parse({}), cwd, home, undefined, pad));
		expect(row?.status).toBe("warn");
		expect(row?.detail).toContain("cros");
	});

	test("a live runtime that is off beats a settings file that says on", async () => {
		// `/gamepad off` writes the setting and disables the pad in one move, but a
		// session started with `--no-gamepad` has a runtime saying off and a file
		// still saying on. What the session is doing is the answer worth printing.
		const { home, cwd } = makeDirs();
		const pad = padConfigFrom(SettingsSchema.parse({ gamepad: { enabled: false } }));
		const row = padRow(
			await runDoctorChecks(SettingsSchema.parse({ gamepad: { enabled: true } }), cwd, home, undefined, pad),
		);
		expect(row?.detail).toBe("off — /gamepad on, or --gamepad for one run");
	});
});

/**
 * The Network row, which is the one place the repo says out loud whether the
 * network restriction can be backed up on the machine asking.
 *
 * Driven through an injected platform rather than skipped per OS, because the
 * Windows branch is the one that matters: a test that only ran where the author
 * happens to be would report the row as fine and never read the sentence that
 * admits the proxy is the whole boundary.
 */
describe("the Network row", () => {
	function networkRow(
		settings: ReturnType<typeof SettingsSchema.parse>,
		cwd: string,
		home: string,
		platform: string,
		hasNativeBackend: boolean,
		sandboxBackend?: SandboxBackend,
		appContainerReason?: string,
	) {
		return runDoctorChecks(
			settings,
			cwd,
			home,
			undefined,
			undefined,
			platform,
			hasNativeBackend,
			undefined,
			sandboxBackend,
			appContainerReason,
		).then((checks) => checks.find((c) => c.name === "Network"));
	}

	const restricted = () => SettingsSchema.parse({ networkAccess: "restricted", networkDomains: ["x.test"] });

	/**
	 * Five rows, and the pair is the whole point.
	 *
	 * This table used to be four platforms against one status, and it read
	 * `darwin → ok`, `linux → ok` off `platform === "darwin" || platform ===
	 * "linux"`. That predicate is the bug: it says `ok` on a Linux box with no
	 * bubblewrap, while `/permissions` on the same session says the backend is
	 * missing. So `hasNativeBackend` is now driven separately, and the row that
	 * matters most is the fourth — the same platform, the same settings, a
	 * different machine, and the honest answer flips. A test with only the three
	 * platforms that *have* backends cannot tell the old predicate from the new
	 * one, which is why the table needs the flag at all.
	 */
	test.each([
		["darwin", true, "ok"],
		["linux", true, "ok"],
		// Same platform, same settings, backend not installed. This is the row that
		// was `ok` before and must not be.
		["linux", false, "warn"],
		// A platform with no backend at all, whether one is "installed" or not.
		["win32", true, "warn"],
		["freebsd", true, "warn"],
	] as const)("on %s with a native backend %s the row is %s", async (platform, hasNativeBackend, status) => {
		const { home, cwd } = makeDirs();
		const row = await networkRow(
			SettingsSchema.parse({ networkAccess: "restricted", networkDomains: ["registry.npmjs.org"] }),
			cwd,
			home,
			platform,
			hasNativeBackend,
		);
		expect(row?.status).toBe(status);
		expect(row?.detail).toContain("1 domain allowed");
	});

	/**
	 * The two `warn` cases are different problems, so the row has to name which.
	 *
	 * "The proxy is the whole boundary" is true of both, and it is the sentence
	 * a user reads while deciding whether to trust the setting. What they act on
	 * is the difference: one is fixed by a package they can install, the other
	 * only by a build that does not exist. Averaging the two into one sentence is
	 * the same mistake as averaging the two `ok` cases used to be.
	 */
	test.each([
		["linux", false, "not installed here"],
		["win32", true, "Windows container backend was not selected"],
	] as const)("on %s the warn names the reason, not just the boundary", async (platform, hasNative, phrase) => {
		const { home, cwd } = makeDirs();
		const row = await networkRow(restricted(), cwd, home, platform, hasNative);
		expect(row?.status).toBe("warn");
		expect(row?.detail).toContain(phrase);
		expect(row?.detail).toContain("HTTP_PROXY/HTTPS_PROXY/ALL_PROXY");
	});

	test("the ok row says which kernel shape it is, and the two shapes differ", async () => {
		// The sentence `/permissions` prints for each native case, and the reason
		// each row needs its own copy: `ok` means the kernel, not the program, is
		// what holds the boundary — and the one route the kernel leaves standing
		// is a different mechanism per platform. On macOS the seatbelt profile
		// keeps the proxy's own loopback ports open; on Linux the proxy sits
		// outside the namespace and a loopback bridge carries its ports inward. A
		// row that averaged the two would name a mechanism the other platform
		// does not have.
		const { home, cwd } = makeDirs();
		const linux = await networkRow(restricted(), cwd, home, "linux", true);
		expect(linux?.status).toBe("ok");
		expect(linux?.detail).toContain(
			"denies a command every route off the machine except the loopback bridge into the proxy",
		);
		expect(linux?.detail).toContain("the allowed list governs both shell and web tools");
		expect(linux?.detail).not.toContain("the local proxy's own loopback ports");

		const darwin = await networkRow(restricted(), cwd, home, "darwin", true);
		expect(darwin?.status).toBe("ok");
		expect(darwin?.detail).toContain("except the local proxy's own loopback ports");
		expect(darwin?.detail).toContain("the allowed list governs both shell and web tools");
		expect(darwin?.detail).not.toContain("loopback bridge");
		// The inverse: the four proxy-only cases must not claim a kernel holds it.
		for (const [platform, hasNative] of [
			["linux", false],
			["win32", true],
			["freebsd", true],
		] as const) {
			expect((await networkRow(restricted(), cwd, home, platform, hasNative))?.detail).not.toContain("OS sandbox");
		}
	});

	test("the Windows row without session facts says the machine, not the build", async () => {
		const { home, cwd } = makeDirs();
		const row = await networkRow(restricted(), cwd, home, "win32", true);
		// The names, not "sandbox on". A user reading this row on Windows is
		// deciding whether to trust the setting, and the difference between
		// "restricted" and "restricted, as long as the program is honest about
		// proxy variables" is the entire content of that decision. "This build
		// ships no OS-level sandbox" would be false about this platform — the
		// container exists in the build — so a caller without the session's
		// facts gets the machine-case default instead.
		expect(row?.detail).toContain("HTTP_PROXY/HTTPS_PROXY/ALL_PROXY");
		expect(row?.detail).toContain("Windows container backend was not selected");
		expect(row?.detail).not.toContain("ships no OS-level sandbox");
	});

	/**
	 * One runtime, one answer. The row used to derive the backend from
	 * `platform` alone, so on Windows it read `simulated` — "this build ships
	 * no OS-level sandbox" — in sessions whose `/permissions` sentence said the
	 * OS was enforcing it. These two tests hold the two surfaces to the same
	 * words for the same facts.
	 */
	test("a selected container is never described as a missing build", async () => {
		const { home, cwd } = makeDirs();
		const row = await networkRow(restricted(), cwd, home, "win32", false, "appcontainer");
		expect(row?.status).toBe("warn");
		expect(row?.detail).toContain("does not confine the network axis");
		// The shared clause, word for word: if either surface rewords the
		// loopback fact, this fails and both get read again.
		expect(row?.detail).toContain("listens on loopback, which a container child cannot reach");
		const permissions = describeSandboxBackend("appcontainer", "workspace-write", "win32");
		expect(permissions).toContain("listens on loopback, which a container child cannot reach");
		// The two claims the row must not make: the build's absence, and a
		// kernel denial the restricted command never got.
		expect(row?.detail).not.toContain("ships no OS-level sandbox");
		expect(row?.detail).not.toContain("every route off the machine");
	});

	test("a declined container carries the probe's why into the row", async () => {
		const { home, cwd } = makeDirs();
		const why = "the container could not run cmd.exe (the probe ended at exit 3221225794)";
		const row = await networkRow(restricted(), cwd, home, "win32", false, "simulated", why);
		expect(row?.status).toBe("warn");
		expect(row?.detail).toContain("Windows container backend was not selected");
		expect(row?.detail).toContain(why);
		// The same why, in the sentence `/permissions` prints for that machine.
		expect(describeSandboxBackend("simulated", "workspace-write", "win32", why)).toContain(why);
	});

	test("a session that confines nothing is reported plainly, and not as a warning", async () => {
		// The row has to distinguish "not restricted" from "restricted and not
		// enforceable here". A warn on the default would be noise on every machine
		// in the repository, and a warn is the signal that makes the Windows case
		// worth reading.
		const { home, cwd } = makeDirs();
		for (const platform of ["darwin", "linux", "win32", "freebsd"]) {
			const row = await networkRow(SettingsSchema.parse({}), cwd, home, platform, true);
			expect(row?.status).toBe("ok");
			expect(row?.detail).toBe("not restricted — commands reach whatever the host can reach");
		}
	});

	test("`restricted` with an empty list says nothing is reachable", async () => {
		// The two axes are separate settings, so this is a configuration someone
		// can write by accident. A row that said "1 policy" or nothing at all
		// would leave a session that cannot fetch looking configured.
		const { home, cwd } = makeDirs();
		const row = await networkRow(SettingsSchema.parse({ networkAccess: "restricted" }), cwd, home, "linux", true);
		expect(row?.detail).toContain("nothing is reachable");
	});

	/**
	 * The `ok` row's over-claim, and the guard that keeps it from becoming one.
	 *
	 * "Shell traffic goes through the proxy" is a true statement about a command
	 * the Bash tool handed a policy, and a false statement about the repo in
	 * general: the HTTP MCP transport is not handed one — there is no spawn to
	 * confine, its traffic is this process's own — so on the very machine where
	 * the row says `ok`, that is the path that can still reach out. The row says
	 * so. (The `!` prompt prefix and then hooks and MCP stdio servers each left
	 * this list when they were handed the workspace policy; all three moved to
	 * the control below.)
	 *
	 * The second table is the part that matters, because a sentence is the
	 * cheapest thing in the repo to leave stale — nothing fails when a path
	 * becomes covered and the list is not updated. So each row reads the call
	 * site itself and fails when it stops being unwired, and the control below
	 * reads call sites that *are* covered and finds the policy, which is what
	 * shows the window is looking where it claims to.
	 */
	test("the `ok` row names the paths that are not covered by any of it", async () => {
		const { home, cwd } = makeDirs();
		const row = await networkRow(
			SettingsSchema.parse({ networkAccess: "restricted", networkDomains: ["registry.npmjs.org"] }),
			cwd,
			home,
			"linux",
			true,
		);
		expect(row?.status).toBe("ok");
		for (const path of COMMAND_PATHS_WITHOUT_SANDBOX) {
			expect(row?.detail).toContain(path);
		}
		expect(row?.detail).toContain("outside all of it");
	});

	test("the list is exactly this, and not merely this", () => {
		// The two guards around this list are one-directional on their own, and the
		// gap between them is the interesting one. The table below reads each call
		// site and fails when a listed path becomes *covered*; the row and the
		// README assertions read the prose and fail when a listed path is not
		// *named*. Neither notices a path that was never listed, so dropping one
		// from the constant — without wiring it, and so with the call site still
		// unwired — leaves every other guard green while `/doctor` and the README
		// both under-report. This is the assertion that closes it: an independent
		// literal, which has to be edited deliberately.
		expect([...COMMAND_PATHS_WITHOUT_SANDBOX]).toEqual(["MCP HTTP servers"]);
	});

	test.each([
		["MCP HTTP servers", join(SRC, "..", "..", "mcp", "src", "client.ts"), "new StreamableHTTPClientTransport("],
	])("%s is still started without a sandbox policy", (_label, file, anchor) => {
		const window = callSite(readFileSync(file, "utf8"), anchor);
		expect(window).not.toContain("sandbox:");
		expect(window).not.toContain("HTTP_PROXY");
	});

	test.each([
		["the Bash tool", join(SRC, "..", "..", "tools", "src", "bash.ts"), "ops.exec({", "sandbox:"],
		["the `!` prompt prefix", join(SRC, "shell-passthrough.ts"), "opts.ops.exec({", "sandbox:"],
		["hooks", join(SRC, "hooks.ts"), "const prepared = confine", "await confine("],
		[
			"MCP stdio servers",
			join(SRC, "..", "..", "mcp", "src", "client.ts"),
			"async function stdioTransport(",
			"await confine(",
		],
	])("%s is covered, and must stay so", (_label, file, anchor, needle) => {
		// The control. Without it the table above could be green because the
		// window is empty, or because the anchor moved, and both would read as
		// "still unwired" — which is the one answer in this file that must never
		// be produced by accident. The `!` prefix, then hooks and the stdio
		// transport, each moved here from the table above when they were handed
		// the workspace policy; same positive form, so one cannot quietly go
		// back to being unwired.
		const window = callSite(readFileSync(file, "utf8"), anchor);
		expect(window).toContain(needle);
	});

	test("the README names the same paths, and does not claim otherwise", () => {
		// `README.md` states the same fact in prose, for a reader deciding whether
		// to trust the mode they are about to pick — which is a decision made
		// before `/doctor` is ever opened. Same reasoning as the migration-source
		// list in `migrate-opencode.test.ts`: a list TypeScript cannot reach needs
		// something that reads it.
		//
		// The negative is the load-bearing half. The bullet used to say the network
		// half is "really enforced on all three platforms", which is true of a
		// Bash-tool command and false of everything else, and nothing about that
		// sentence could fail.
		const readme = readFileSync(join(SRC, "..", "..", "..", "README.md"), "utf8");
		for (const path of COMMAND_PATHS_WITHOUT_SANDBOX) {
			expect(readme).toContain(path);
		}
		expect(readme).not.toContain("really enforced on all three platforms");
		// The sentence this note replaced — "Three paths do not get the proxy" —
		// must not come back either: two of those paths are covered now, and a
		// reader deciding whether to trust `restricted` is owed the current shape.
		expect(readme).not.toContain("Three paths do not get the proxy");
	});
});
