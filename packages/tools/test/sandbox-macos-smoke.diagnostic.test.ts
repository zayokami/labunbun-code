/**
 * TEMPORARY DIAGNOSTIC — not a permanent test. Delete once the answer is known.
 *
 * SIGTRAP (exit 133) kills /bin/echo as well as bun under any profile carrying
 * our BASE_POLICY, while (allow default) runs both. So the fault is a single
 * line in the base, and SIGTRAP is what seatbelt raises for a policy it
 * refuses at runtime rather than a parse error. Test the base one line at a
 * time, always with (allow process-exec) and (allow file-read*) present so a
 * rung that compiles also runs. Control first.
 */
import { expect, test } from "bun:test";

const MINIMUM = `(allow process-exec)\n(allow file-read*)`;

async function run(body: string): Promise<string> {
	const proc = Bun.spawn(
		["/usr/bin/sandbox-exec", "-p", `(version 1)\n(deny default)\n${body}\n`, "--", "/bin/echo", "MARKER-OK"],
		{
			stdout: "pipe",
			stderr: "pipe",
		},
	);
	const [out, err, code] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	const brief = (s: string) => JSON.stringify(s.length > 200 ? `${s.slice(0, 200)}…(${s.length})` : s);
	return `exit=${code} out=${brief(out)} err=${brief(err)}`;
}

const LINES: [string, string][] = [
	["process-fork", `(allow process-fork)`],
	["signal-same-sandbox", `(allow signal (target same-sandbox))`],
	["process-info-star", `(allow process-info*)`],
	["pseudo-tty", `(allow pseudo-tty)`],
	["dev-null", `(allow file-read* file-write* file-ioctl (literal "/dev/null"))`],
	["dev-ptmx", `(allow file-read* file-write* file-ioctl (literal "/dev/ptmx"))`],
	["ttys-ioctl", `(allow file-ioctl (regex #"^/dev/ttys[0-9]+"))`],
	["iokit", `(allow iokit-open (iokit-registry-entry-class "RootDomainUserClient"))`],
	["ipc-posix-sem", `(allow ipc-posix-sem)`],
	[
		"shm-three",
		`(allow ipc-posix-shm-read-data)\n(allow ipc-posix-shm-write-create)\n(allow ipc-posix-shm-write-unlink)`,
	],
	[
		"mach-two",
		`(allow mach-lookup\n  (global-name "com.apple.system.opendirectoryd.libinfo")\n  (global-name "com.apple.PowerManagement.control"))`,
	],
	[
		"mach-two-separate",
		`(allow mach-lookup (global-name "com.apple.system.opendirectoryd.libinfo"))\n(allow mach-lookup (global-name "com.apple.PowerManagement.control"))`,
	],
	["network-outbound", `(allow network-outbound)\n(allow network-inbound)`],
	["system-socket", `(allow system-socket\n  (require-all\n    (socket-domain AF_SYSTEM)\n    (socket-protocol 2)))`],
];

test("which base line traps", async () => {
	if (process.platform !== "darwin") return;
	const rows: string[] = [];
	rows.push(`CONTROL allow-default: ${await run("(allow default)")}`);
	rows.push(`MINIMUM: ${await run(MINIMUM)}`);
	for (const [name, body] of LINES) rows.push(`${name}: ${await run(`${body}\n${MINIMUM}`)}`);
	expect(rows.join("\n")).toBe("table");
}, 180_000);
