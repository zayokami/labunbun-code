/**
 * TEMPORARY DIAGNOSTIC — not a permanent test. Delete once the answer is known.
 *
 * The hand-assembled base (every rule, no comments) runs /bin/echo: exit=0. The
 * base as the file spells it, reached through buildSeatbeltArgs, gave exit=133.
 * Two things differ — the `;` comments and the cwd the process starts in — so
 * vary one at a time instead of guessing. Control first; a control that fails
 * voids every other row.
 */
import { expect, test } from "bun:test";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildSandboxPolicy } from "@labunbun/agent";
import { buildSeatbeltArgs } from "../src/sandbox/seatbelt.ts";

const REAL = realpathSync(mkdtempSync(join(tmpdir(), "lbb-cwd-")));

async function run(body: string, cwd?: string): Promise<string> {
	const proc = Bun.spawn(
		["/usr/bin/sandbox-exec", "-p", `(version 1)\n(deny default)\n${body}\n`, "--", "/bin/echo", "MARKER-OK"],
		{ stdout: "pipe", stderr: "pipe", ...(cwd === undefined ? {} : { cwd }) },
	);
	const [out, err, code] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	const brief = (s: string) => JSON.stringify(s.length > 200 ? `${s.slice(0, 200)}…(${s.length})` : s);
	return `exit=${code} out=${brief(out)} err=${brief(err)}`;
}

const MIN = `(allow process-exec)\n(allow file-read*)`;

/** Every base rule, no comments — the shape that measured exit=0. */
const RULES = [
	`(allow process-fork)`,
	`(allow process-exec)`,
	`(allow signal (target same-sandbox))`,
	`(allow process-info*)`,
	`(allow pseudo-tty)`,
	`(allow file-read* file-write* file-ioctl (literal "/dev/null"))`,
	`(allow file-read* file-write* file-ioctl (literal "/dev/ptmx"))`,
	`(allow file-ioctl (regex #"^/dev/ttys[0-9]+"))`,
	`(allow iokit-open (iokit-registry-entry-class "RootDomainUserClient"))`,
	`(allow ipc-posix-shm-read-data)`,
	`(allow ipc-posix-shm-write-create)`,
	`(allow ipc-posix-shm-write-unlink)`,
	`(allow ipc-posix-sem)`,
	`(allow mach-lookup\n  (global-name "com.apple.system.opendirectoryd.libinfo")\n  (global-name "com.apple.PowerManagement.control"))`,
].join("\n");

test("comments or cwd", async () => {
	if (process.platform !== "darwin") return;
	const rows: string[] = [];

	// Control in both cwds, so a cwd-specific failure is visible as such.
	rows.push(`CONTROL-repo: ${await run("(allow default)")}`);
	rows.push(`CONTROL-tmp: ${await run("(allow default)", REAL)}`);

	// Vary cwd, no comments.
	rows.push(`RULES-repo: ${await run(RULES)}`);
	rows.push(`RULES-tmp: ${await run(RULES, REAL)}`);

	// Vary comments, same cwd. The file's own text, comments included.
	const full = buildSeatbeltArgs(buildSandboxPolicy({ sandbox: "workspace-write", workspace: REAL }), [
		"/bin/echo",
		"MARKER-OK",
	]);
	const profile = full[1] ?? "";
	const params = full.slice(2).filter((a) => a !== "--");
	const baseWithComments = profile.split("\n; Read baseline")[0] ?? "";
	rows.push(`COMMENTS-repo: ${await run(`${baseWithComments}\n${MIN}`)}`);
	rows.push(`COMMENTS-tmp: ${await run(`${baseWithComments}\n${MIN}`, REAL)}`);

	// The whole thing, as production builds it.
	const prod = Bun.spawn;
	void prod;
	rows.push(`FULL-profile-tmp: ${await spawnFull(profile, params, REAL)}`);

	// The same profile text with every `;` comment line deleted: if this passes
	// and COMMENTS-tmp does not, a comment is the trigger.
	const stripped = baseWithComments
		.split("\n")
		.filter((line) => !line.trimStart().startsWith(";"))
		.join("\n");
	rows.push(`STRIPPED-repo: ${await run(`${stripped}\n${MIN}`)}`);
	rows.push(`STRIPPED-tmp: ${await run(`${stripped}\n${MIN}`, REAL)}`);

	expect(rows.join("\n")).toBe("table");
}, 180_000);

async function spawnFull(profile: string, params: string[], cwd: string): Promise<string> {
	const proc = Bun.spawn(["/usr/bin/sandbox-exec", "-p", profile, ...params, "--", "/bin/echo", "MARKER-OK"], {
		stdout: "pipe",
		stderr: "pipe",
		cwd,
	});
	const [out, err, code] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	const brief = (s: string) => JSON.stringify(s.length > 200 ? `${s.slice(0, 200)}…(${s.length})` : s);
	return `exit=${code} out=${brief(out)} err=${brief(err)}`;
}
