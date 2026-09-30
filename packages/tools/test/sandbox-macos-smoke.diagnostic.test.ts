/**
 * TEMPORARY DIAGNOSTIC — not a permanent test. Delete once the answer is known.
 *
 * Every line of BASE_POLICY passes on its own and (allow default) is green, yet
 * the assembled base traps even /bin/echo with SIGTRAP (133). So the fault needs
 * a combination. Test the assembled base, then leave-one-out to find the line
 * that only misbehaves in company, then pairs. (allow process-exec) and
 * (allow file-read*) stay in every rung so a compiling rung also runs.
 */
import { expect, test } from "bun:test";

const MINIMUM = `(allow process-exec)\n(allow file-read*)`;

async function run(body: string): Promise<string> {
	const proc = Bun.spawn(
		["/usr/bin/sandbox-exec", "-p", `(version 1)\n(deny default)\n${body}\n`, "--", "/bin/echo", "MARKER-OK"],
		{ stdout: "pipe", stderr: "pipe" },
	);
	const [out, err, code] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	const brief = (s: string) => JSON.stringify(s.length > 200 ? `${s.slice(0, 200)}…(${s.length})` : s);
	return `exit=${code} out=${brief(out)} err=${brief(err)}`;
}

/** BASE_POLICY's rules, in the order the file emits them, minus the header. */
const LINES: [string, string][] = [
	["fork", `(allow process-fork)`],
	["exec", `(allow process-exec)`],
	["signal", `(allow signal (target same-sandbox))`],
	["pinfo", `(allow process-info*)`],
	["ptty", `(allow pseudo-tty)`],
	["devnull", `(allow file-read* file-write* file-ioctl (literal "/dev/null"))`],
	["devptmx", `(allow file-read* file-write* file-ioctl (literal "/dev/ptmx"))`],
	["ttysioctl", `(allow file-ioctl (regex #"^/dev/ttys[0-9]+"))`],
	["iokit", `(allow iokit-open (iokit-registry-entry-class "RootDomainUserClient"))`],
	["shmr", `(allow ipc-posix-shm-read-data)`],
	["shmw", `(allow ipc-posix-shm-write-create)`],
	["shmu", `(allow ipc-posix-shm-write-unlink)`],
	["sem", `(allow ipc-posix-sem)`],
	[
		"mach",
		`(allow mach-lookup\n  (global-name "com.apple.system.opendirectoryd.libinfo")\n  (global-name "com.apple.PowerManagement.control"))`,
	],
];

const all = LINES.map(([, body]) => body).join("\n");
const without = (name: string) =>
	LINES.filter(([n]) => n !== name)
		.map(([, body]) => body)
		.join("\n");

test("which combination", async () => {
	if (process.platform !== "darwin") return;
	const rows: string[] = [];
	rows.push(`CONTROL: ${await run(MINIMUM)}`);
	rows.push(`ALL: ${await run(`${all}\n(allow file-read*)`)}`);
	// Leave-one-out: if dropping a line turns the trap green, that line is in the
	// combination. If every drop is still 133, no single line is responsible.
	for (const [name] of LINES) rows.push(`ALL-minus-${name}: ${await run(`${without(name)}\n(allow file-read*)`)}`);
	// Halves, in case the interaction is not with one line at all.
	rows.push(
		`HALF-1: ${await run(
			`${LINES.slice(0, 7)
				.map(([, b]) => b)
				.join("\n")}\n(allow file-read*)`,
		)}`,
	);
	rows.push(
		`HALF-2: ${await run(
			`${LINES.slice(7)
				.map(([, b]) => b)
				.join("\n")}\n${MINIMUM}`,
		)}`,
	);
	expect(rows.join("\n")).toBe("table");
}, 180_000);
