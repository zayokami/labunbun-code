/**
 * The AppContainer backend, tested against the machine it describes.
 *
 * The split is deliberate and follows the one `sandbox-simulated.test.ts`
 * established: pure logic runs on every machine, and the real-spawn half is
 * Windows-only. A skipped test must be visible, and bun reports skip counts in
 * its summary — so a non-Windows machine reports `N skip`, never green — and
 * the real coverage is the Windows CI job plus the Windows machine this was
 * written on. What is NOT done here is asserting the acquisition-semantics
 * half (the ACL grant): that is not wired yet, and a test for it would be a
 * test for code that does not exist.
 */
import { describe, expect, test } from "bun:test";
import { execSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	type AppContainerProfile,
	acquireWorkspaceGrant,
	appContainerAvailable,
	appContainerProfileName,
	confinedCommandLine,
	confinedEnvBlock,
	confinedProgramName,
	containerCanExecute,
	deleteAppContainerProfile,
	deriveAppContainerSid,
	ensureAppContainerProfile,
	releaseWorkspaceGrant,
	runConfined,
} from "../src/sandbox/appcontainer.ts";

describe("the profile name", () => {
	test("one workspace, one name — the SID is derived from it, so stability is load-bearing", () => {
		expect(appContainerProfileName("C:\\Ws")).toBe(appContainerProfileName("C:\\Ws"));
	});

	test("case and separators are the same directory on Windows", () => {
		expect(appContainerProfileName("C:\\Ws")).toBe(appContainerProfileName("c:/ws"));
	});

	test("different workspaces get different names", () => {
		expect(appContainerProfileName("C:\\Ws")).not.toBe(appContainerProfileName("C:\\Other"));
	});

	test("the name is a profile the API will accept: lowercase, hyphens, hex", () => {
		const name = appContainerProfileName("C:\\Ws");
		expect(name).toMatch(/^labunbun-[0-9a-f]{16}$/);
		expect(name.length).toBeLessThan(64);
	});

	test("the network variant is a name of its own — the capability is baked, so the mode rides in the name", () => {
		// One workspace, two profiles: capabilities are fixed at creation and
		// the ALREADY_EXISTS path ignores a later capability argument, so a
		// single name could never carry both modes. The two names must never
		// collide, and the net one must keep the same shape.
		const offline = appContainerProfileName("C:\\Ws");
		const net = appContainerProfileName("C:\\Ws", true);
		expect(offline).not.toBe(net);
		expect(net).toMatch(/^labunbun-net-[0-9a-f]{16}$/);
		// Case and separators still fold: `c:/ws` online is the same profile.
		expect(net).toBe(appContainerProfileName("c:/ws", true));
		// And a different workspace's net profile is a different profile.
		expect(net).not.toBe(appContainerProfileName("C:\\Other", true));
	});
});

/**
 * The program name that starts a confined command line.
 *
 * Pure, for the same reason the quoting rule is: what the kernel does with
 * the first token of `lpCommandLine` is a property of CreateProcessW.
 *
 * Measured: a bare `cmd.exe` fails with 203 (ERROR_INVALID_FUNCTION) because
 * the constrained child token resolves the name without a usable PATH, so
 * the name has to arrive already absolute.
 */
describe("the program name a confined command line starts with", () => {
	test("a bare name is resolved under System32", () => {
		expect(confinedProgramName("cmd.exe")).toBe("C:\\Windows\\System32\\cmd.exe");
	});

	test("a name that already carries a separator is used exactly as given", () => {
		expect(confinedProgramName("C:\\Tools\\bash.exe")).toBe("C:\\Tools\\bash.exe");
		expect(confinedProgramName("C:/Tools/bash.exe")).toBe("C:/Tools/bash.exe");
	});
});

const describeWindows = process.platform === "win32" ? describe : describe.skip;

describe("the command line CreateProcessW is handed", () => {
	// Pure, and run on every machine for that reason: the quoting rule is a
	// property of the Windows command-line format, not of the machine parsing
	// it.
	//
	// The form is **verbatim** — one layer of quotes, nothing escaped — and
	// that shape is measured rather than chosen: `cmd /c` with `/s` takes the
	// text between the quotes exactly as it stands, so an escaped `\"`
	// survives into the shell as a literal backslash-quote pair and every
	// command containing a quote fails. Node's own spawn with default quoting
	// fails the same command; with `windowsVerbatimArguments` it passes. The
	// cases below pin each rule that shape depends on.

	test("an argument with no space, tab, or quote is passed verbatim", () => {
		expect(confinedCommandLine(["C:\\Windows\\System32\\cmd.exe", "/d", "/s", "/c"])).toBe(
			"C:\\Windows\\System32\\cmd.exe /d /s /c",
		);
	});

	test("an argument with a space is wrapped, which is what a Program Files shell path needs", () => {
		expect(confinedCommandLine(["C:\\Program Files\\Git\\bin\\bash.exe"])).toBe(
			'"C:\\Program Files\\Git\\bin\\bash.exe"',
		);
	});

	test("an embedded quote is left standing, which is what cmd /s needs from a redirection", () => {
		// The whole point of the verbatim form: `echo written > "path"` must
		// reach cmd with its quotes intact. Escaping them — the shape
		// `CommandLineToArgvW` would parse back — makes cmd fail the command
		// with a syntax error instead.
		expect(confinedCommandLine(["cmd.exe", "/c", 'echo written > "C:\\out\\f.txt"'])).toBe(
			'cmd.exe /c "echo written > "C:\\out\\f.txt""',
		);
	});

	test("a backslash before a quote survives as itself", () => {
		// Two literal backslashes followed by a quote: under the verbatim form
		// nothing doubles, because the quotes the shell strips around the
		// argument are not quotes the program will parse as escaped.
		expect(confinedCommandLine(['a\\\\"b'])).toBe('"a\\\\"b"');
	});

	test("a backslash ending the argument is kept, because the closing quote here is the shell's", () => {
		// The one that silently breaks everything after it under the escaped
		// form — a trailing backslash would eat the closing quote. Under the
		// verbatim form it is a literal backslash and the argument terminates
		// at the quote as written.
		expect(confinedCommandLine(["C:\\path with space\\"])).toBe('"C:\\path with space\\"');
	});

	test("the empty argument is an empty pair of quotes, not a missing one", () => {
		// Dropping it would shift every argument after it left by one — the
		// child would read the wrong argv, and nothing would look wrong.
		expect(confinedCommandLine(["prog", "", "tail"])).toBe('prog "" tail');
	});
});

describe("what a container child can execute", () => {
	// The rule, pin by pin: System32 is the one directory every container
	// child runs without a grant, and a granted root is the other set. The
	// case that earns its own test is the session shell on a machine with
	// Git for Windows — `detectShell` prefers it, it is in neither set, and
	// spawning it there measured as the child dying at DLL initialization
	// with 0xC0000142 on the GitHub Windows runner. The assertion below is
	// what `operations.exec` refuses on.

	test("System32 is executable, in any spelling of it", () => {
		// The name arrives resolved — `confinedProgramName` already turned a
		// bare `cmd.exe` into this — but the case and the separators are the
		// policy's, not the kernel's.
		expect(containerCanExecute("C:\\Windows\\System32\\cmd.exe", [])).toBe(true);
		expect(containerCanExecute("c:/windows/system32/windowspowershell/v1.0/powershell.exe", [])).toBe(true);
	});

	test("a granted root changes the answer, which is the grant doing work rather than permission", () => {
		// A copy of bash inside the granted workspace runs — the measured
		// difference between "Access is denied" and a run. Same shape from
		// `acquireWorkspaceGrant`'s own test, from the program's side.
		expect(containerCanExecute("D:\\Ws\\bin\\bash.exe", ["D:\\Ws"])).toBe(true);
		expect(containerCanExecute("D:\\Ws\\bin\\bash.exe", ["d:/ws"])).toBe(true);
	});

	test("outside both sets is refused — the Program Files session shell", () => {
		expect(containerCanExecute("C:\\Program Files\\Git\\bin\\bash.exe", [])).toBe(false);
		// The prefix trap: `D:\Ws2` is not inside `D:\Ws` even though the
		// string starts with it, and a prefix check that ignored the
		// separator would grant a sibling.
		expect(containerCanExecute("D:\\Ws2\\bash.exe", ["D:\\Ws"])).toBe(false);
		// An empty root is a root that grants nothing.
		expect(containerCanExecute("D:\\Ws\\bash.exe", [""])).toBe(false);
	});
});

describe("the environment block CreateProcessW is handed", () => {
	/** The block read back as UTF-16, which is the only way to inspect what the child would see. */
	function readBlock(block: Uint8Array): string {
		let out = "";
		for (let i = 0; i + 1 < block.length; i += 2) {
			const code = block[i] | (block[i + 1] << 8);
			out += String.fromCharCode(code);
		}
		return out;
	}

	test("entries are K=V joined with NULs and the block ends with two", () => {
		const block = readBlock(confinedEnvBlock({ PATH: "C:\\Windows", HOME: "C:\\Users\\x" }));
		expect(block).toBe("PATH=C:\\Windows\0HOME=C:\\Users\\x\0\0");
	});

	test("an empty environment is a single NUL, which is a terminated empty block", () => {
		expect(readBlock(confinedEnvBlock({}))).toBe("\0");
	});

	test("a key naming = is dropped rather than parsed as two variables", () => {
		// `A=B=C` in a key position is read by the CRT as key `A`, value `B=C`
		// — which invents a variable the caller never set.
		expect(readBlock(confinedEnvBlock({ "BAD=KEY": "v", GOOD: "w" }))).toBe("GOOD=w\0\0");
	});

	test("a value with an embedded NUL is dropped rather than truncating the block", () => {
		// A NUL inside a value would end that entry early and leave the rest of
		// the block read as garbage by the child.
		expect(readBlock(confinedEnvBlock({ BAD: "a\0b", KEEP: "v" }))).toBe("KEEP=v\0\0");
	});
});

describeWindows("the grant that lets a confined command touch the workspace", () => {
	function scaffold(root: string): void {
		execSync(`cmd /c if exist "${root}" rmdir /s /q "${root}"`, { stdio: "ignore" });
		execSync(`cmd /c mkdir "${root}\\src" "${root}\\.git"`, { stdio: "ignore" });
		writeFileSync(join(root, "src", "file.txt"), "workspace file\n");
		writeFileSync(join(root, ".git", "config"), "[core]\n");
	}

	const root = `${process.env.LOCALAPPDATA}\\Temp\\ac-grant-${process.pid}`;
	const outside = `C:\\Windows\\Temp\\ac-grant-outside-${process.pid}.txt`;

	test("the workspace is writable and everything beyond it is not", () => {
		scaffold(root);
		const grant = acquireWorkspaceGrant(root);
		try {
			expect(grant.error).toBeUndefined();
			const profile = grant.profile as AppContainerProfile;

			// Inside the workspace: the write lands.
			const wrote = runConfined(
				profile,
				`"C:\\Windows\\System32\\cmd.exe" /c echo confined > "${root}\\src\\confined.txt" && exit 42`,
				{ cwd: root },
			);
			expect(wrote.exitCode).toBe(42);
			expect(existsSync(join(root, "src", "confined.txt"))).toBe(true);

			// Outside the workspace: refused by the kernel, and the file never appears.
			const escaped = runConfined(profile, `"C:\\Windows\\System32\\cmd.exe" /c echo pwned > "${outside}" && exit 43`, {
				cwd: root,
			});
			expect(escaped.exitCode).not.toBe(43);
			expect(existsSync(outside)).toBe(false);
		} finally {
			releaseWorkspaceGrant(root);
		}
	});

	test("after release the grant's ACEs are gone and the workspace is as it was", () => {
		scaffold(root);
		const first = acquireWorkspaceGrant(root);
		expect(first.error).toBeUndefined();
		const profile = first.profile as AppContainerProfile;
		// A second command under the same workspace shares the one grant.
		const second = acquireWorkspaceGrant(root);
		expect(second.error).toBeUndefined();
		expect(releaseWorkspaceGrant(root)).toBeNull(); // still referenced by the first
		const stillWritable = runConfined(
			profile,
			`"C:\\Windows\\System32\\cmd.exe" /c echo x > "${root}\\src\\shared.txt" && exit 42`,
			{ cwd: root },
		);
		// The post-condition, not the exit code: `&& exit 42` runs even when
		// cmd's redirection fails, so an exit code alone passes for a write
		// that never happened.
		expect(stillWritable.exitCode).toBe(42);
		expect(existsSync(join(root, "src", "shared.txt"))).toBe(true);
		expect(releaseWorkspaceGrant(root)).toBeNull(); // the last one released
		// With the grant gone the container is back to seeing nothing — the
		// write that worked a moment ago now fails.
		const nowBlocked = runConfined(
			profile,
			`"C:\\Windows\\System32\\cmd.exe" /c echo x > "${root}\\src\\again.txt" && exit 43`,
			{ cwd: root },
		);
		expect(nowBlocked.exitCode).not.toBe(43);
		// And the owner's own access never depended on the grant.
		writeFileSync(join(root, "src", "owner.txt"), "still mine\n");
		expect(existsSync(join(root, "src", "owner.txt"))).toBe(true);
	});

	test("every writable root the policy grants is writable, not only the workspace", () => {
		// A real session's policy names the temp directory and the home package
		// caches beside the workspace, and a grant that covered only the
		// workspace would leave `mktemp` refused — the narrower-than-asked shape
		// that costs a command its cache on the mode every user gets.
		scaffold(root);
		const cache = `${process.env.LOCALAPPDATA}\\Temp\\ac-cache-${process.pid}`;
		execSync(`cmd /c if exist "${cache}" rmdir /s /q "${cache}"`, { stdio: "ignore" });
		execSync(`cmd /c mkdir "${cache}"`, { stdio: "ignore" });
		const grant = acquireWorkspaceGrant(root, false, [cache]);
		expect(grant.error).toBeUndefined();
		const profile = grant.profile as AppContainerProfile;
		try {
			const toCache = runConfined(
				profile,
				`"C:\\Windows\\System32\\cmd.exe" /c echo cached > "${cache}\\c.txt" && exit 42`,
				{ cwd: root },
			);
			expect(toCache.exitCode).toBe(42);
			expect(existsSync(join(cache, "c.txt"))).toBe(true);

			// A third place is still refused: the grant is exactly its roots.
			const elsewhere = runConfined(
				profile,
				`"C:\\Windows\\System32\\cmd.exe" /c echo nope > "${outside}" && exit 43`,
				{ cwd: root },
			);
			expect(elsewhere.exitCode).not.toBe(43);
			expect(existsSync(outside)).toBe(false);

			releaseWorkspaceGrant(root, false);

			// The release is checked with the same identity the grant named,
			// and while the cache directory still exists. Both details are
			// load-bearing: a different profile is refused whether or not the
			// cache ACE was dropped, and a deleted directory fails for the
			// wrong reason — so either substitution would let a release that
			// drops only the workspace root pass.
			const blocked = runConfined(
				profile,
				`"C:\\Windows\\System32\\cmd.exe" /c echo nope > "${cache}\\c2.txt" && exit 43`,
				{ cwd: "C:\\Windows\\System32" },
			);
			expect(blocked.exitCode).not.toBe(43);
			expect(existsSync(join(cache, "c2.txt"))).toBe(false);
		} finally {
			execSync(`cmd /c if exist "${cache}" rmdir /s /q "${cache}"`, { stdio: "ignore" });
		}
	});
});

describeWindows("the profile lifecycle", () => {
	test("create, derive, and delete work without elevation", () => {
		const workspace = `G:\\labunbun-probe-${process.pid}`;
		const profile = ensureAppContainerProfile(workspace);
		if ("error" in profile) throw new Error(profile.error);
		expect(profile.sid).toMatch(/^S-1-15-2-/);
		// Derivation is a pure function of the name: it holds with no profile
		// in between, and it is unchanged by deleting the profile. That is the
		// property the ACL grant will rest on — the SID a grant names is the
		// SID the next run for the same workspace derives again.
		expect(deriveAppContainerSid(profile.name)).toBe(profile.sid);
		expect(deleteAppContainerProfile(profile.name)).toBe(true);
		expect(deriveAppContainerSid(profile.name)).toBe(profile.sid);
		// The profile store is what delete empties: creating again succeeds
		// with S_OK instead of ALREADY_EXISTS.
		const recreated = ensureAppContainerProfile(workspace);
		if ("error" in recreated) throw new Error(recreated.error);
		expect(recreated.sid).toBe(profile.sid);
		expect(deleteAppContainerProfile(profile.name)).toBe(true);
	});

	test("derivation is deterministic for a name this user never created", () => {
		// It is a hash of the name, not a lookup: this is why a grant naming
		// the SID is stable across runs, and why deleting a profile makes a
		// stale grant reusable-by-name rather than inert.
		const name = appContainerProfileName(`G:\\labunbun-never-${process.pid}`);
		const first = deriveAppContainerSid(name);
		const second = deriveAppContainerSid(name);
		expect(first).toMatch(/^S-1-15-2-/);
		expect(second).toBe(first);
	});

	test("deleting a profile that was never there is success, not failure", () => {
		expect(deleteAppContainerProfile(`labunbun-never-created-${process.pid}`)).toBe(true);
	});
});

describeWindows("a confined process", () => {
	test("runs a command and brings back its output and exit code", () => {
		const workspace = `G:\\labunbun-run-${process.pid}`;
		const profile = ensureAppContainerProfile(workspace);
		if ("error" in profile) throw new Error(profile.error);
		try {
			const echo = runConfined(profile, '"C:\\Windows\\System32\\cmd.exe" /c echo confined-hello');
			expect(echo.error).toBeUndefined();
			expect(echo.exitCode).toBe(0);
			expect(echo.killed).toBe(false); // it exited on its own; nothing killed it
			expect(echo.stdout).toContain("confined-hello");

			const failed = runConfined(profile, '"C:\\Windows\\System32\\cmd.exe" /c exit 7');
			expect(failed.exitCode).toBe(7);

			// The working directory is honoured: %CD% inside the child is the
			// directory handed in, which is what a workspace-write session needs
			// for every relative path a command uses.
			const cwd = process.env.TEMP ?? "C:\\Windows\\Temp";
			const inWorkspace = runConfined(profile, '"C:\\Windows\\System32\\cmd.exe" /c cd', { cwd });
			expect(inWorkspace.stdout.replace(/\r?\n/g, "").toLowerCase()).toBe(cwd.toLowerCase());
		} finally {
			deleteAppContainerProfile(profile.name);
		}
	});

	test("an environment block reaches the child, which is what makes PATH work", () => {
		// The child inherits nothing: CreateProcessW is handed a block this
		// module builds, and CREATE_UNICODE_ENVIRONMENT is what makes the
		// kernel read those bytes as the UTF-16 they are. Measured when the
		// flag was missing: the same block read through the ANSI code page is
		// interleaved NULs to the child's CRT, and every command fails with
		// 203 from CreateProcessW — the flag and the block stand or fall
		// together, so the test carries both.
		//
		// The block is built the way production builds it — process.env with
		// one marker added — and that is not incidental. A block without
		// LOCALAPPDATA fails this spawn with 203 before any command runs
		// (measured; see the note on `confinedEnvBlock`), so a hand-built
		// minimal block would test the quoting and nothing else. The marker
		// is what proves the *content* crossed: `echo %LBB_PROBE%` prints the
		// literal text if the variable never arrived.
		const workspace = `G:\\labunbun-env-${process.pid}`;
		const profile = ensureAppContainerProfile(workspace);
		if ("error" in profile) throw new Error(profile.error);
		try {
			const echoed = runConfined(profile, '"C:\\Windows\\System32\\cmd.exe" /c echo %LBB_PROBE%', {
				env: confinedEnvBlock({ ...process.env, LBB_PROBE: "block-delivered" } as Record<string, string>),
			});
			expect(echoed.error).toBeUndefined();
			expect(echoed.exitCode).toBe(0);
			expect(echoed.stdout).toContain("block-delivered");
		} finally {
			deleteAppContainerProfile(profile.name);
		}
	});

	test("a timeout kills the command rather than leaving it running", () => {
		const workspace = `G:\\labunbun-timeout-${process.pid}`;
		const profile = ensureAppContainerProfile(workspace);
		if ("error" in profile) throw new Error(profile.error);
		try {
			// A busy loop, not `ping` or `timeout`: the container has no
			// network stack at all (loopback included), and timeout.exe refuses
			// to run with a pipe for stdin. The loop also fills the output
			// pipe, which makes the test exercise kill-then-drain on a full
			// pipe — the shape a chatty command that outlives its budget has.
			const hung = runConfined(profile, '"C:\\Windows\\System32\\cmd.exe" /c for /l %i in (1,1,2000000) do rem', {
				timeoutMs: 1500,
			});
			expect(hung.error).toContain("did not exit within 1500ms");
			expect(hung.killed).toBe(true); // this run ended the child, not the child ending
			expect(hung.stdout.length).toBeGreaterThan(1024);
		} finally {
			deleteAppContainerProfile(profile.name);
		}
	});

	test("output streams while the command runs, not in one dump after it exits", () => {
		// The live preview a shell user expects. A chatty command that outlives
		// its budget is the one shape that proves it: every byte the pump
		// collected arrived during the run, and a single post-mortem dump would
		// be one chunk holding the whole output.
		const workspace = `G:\\labunbun-stream-${process.pid}`;
		const profile = ensureAppContainerProfile(workspace);
		if ("error" in profile) throw new Error(profile.error);
		try {
			const chunks: string[] = [];
			const hung = runConfined(profile, '"C:\\Windows\\System32\\cmd.exe" /c for /l %i in (1,1,2000000) do rem', {
				timeoutMs: 800,
				onStdout: (chunk) => chunks.push(chunk),
			});
			expect(hung.error).toContain("did not exit within 800ms");
			expect(chunks.length).toBeGreaterThan(1);
			expect(chunks.join("")).toBe(hung.stdout);
		} finally {
			deleteAppContainerProfile(profile.name);
		}
	});

	test("an abort kills the child and settles the run early", () => {
		const workspace = `G:\\labunbun-abort-${process.pid}`;
		const profile = ensureAppContainerProfile(workspace);
		if ("error" in profile) throw new Error(profile.error);
		try {
			// The abort fires from the first output callback, not a timer:
			// runConfined is synchronous — its FFI waits hold the event loop —
			// so a setTimeout would not run until the run had already finished,
			// which would test the default timeout instead of the abort. That
			// is how this test first hung: it sat out the full 600s budget.
			const controller = new AbortController();
			const startedAt = Date.now();
			let fired = false;
			const hung = runConfined(profile, '"C:\\Windows\\System32\\cmd.exe" /c for /l %i in (1,1,20000000) do rem', {
				signal: controller.signal,
				onStdout: () => {
					if (fired) return;
					fired = true;
					controller.abort();
				},
			});
			const elapsed = Date.now() - startedAt;
			expect(fired).toBe(true); // the callback ran, so this was an abort and not a coincidence
			expect(hung.killed).toBe(true);
			expect(hung.error).toContain("aborted");
			// The loop alone would run for minutes; the run ended seconds after
			// it started, and far inside the default budget.
			expect(elapsed).toBeLessThan(30_000);
		} finally {
			deleteAppContainerProfile(profile.name);
		}
	});

	test("the child actually runs as the container identity, not as this user", () => {
		// The one confinement assertion that does not need a grant. A process
		// in an AppContainer carries the LOW mandatory integrity label and a
		// token whose user groups are deny-only; a child created without the
		// security-capabilities attribute would show Medium Mandatory Level
		// and its groups enabled. Deleting that attribute from the spawner
		// leaves every other assertion green — this is the one that reddens.
		//
		// The working directory is `System32` because a container cannot enter
		// a directory it holds no grant for ("The current directory is
		// invalid"), and this test holds no grant on purpose.
		const workspace = `G:\\labunbun-identity-${process.pid}`;
		const profile = ensureAppContainerProfile(workspace);
		if ("error" in profile) throw new Error(profile.error);
		try {
			const who = runConfined(profile, '"C:\\Windows\\System32\\cmd.exe" /c whoami /groups', {
				cwd: "C:\\Windows\\System32",
			});
			expect(who.error).toBeUndefined();
			expect(who.stdout).toContain("Low Mandatory Level");
			expect(who.stdout).not.toContain("Medium Mandatory Level");
		} finally {
			deleteAppContainerProfile(profile.name);
		}
	});

	test("a command that writes nowhere outside its grant is all a confined run can do", () => {
		// Measured, and the reason the grant half must ship before this backend
		// is wired into the tool path: with no ACL grant the container cannot
		// read the workspace at all, so a real command would fail closed here.
		const workspace = `G:\\labunbun-nogrant-${process.pid}`;
		const profile = ensureAppContainerProfile(workspace);
		if ("error" in profile) throw new Error(profile.error);
		try {
			const result = runConfined(
				profile,
				'"C:\\Windows\\System32\\cmd.exe" /c if exist C:\\Windows\\win.ini echo seen',
			);
			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("seen");
		} finally {
			deleteAppContainerProfile(profile.name);
		}
	});

	test("availability reports honestly on every platform", () => {
		if (process.platform === "win32") expect(appContainerAvailable()).toBe(true);
		else expect(appContainerAvailable()).toBe(false);
	});
});
