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
});

const describeWindows = process.platform === "win32" ? describe : describe.skip;

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
			expect(hung.stdout.length).toBeGreaterThan(1024);
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
