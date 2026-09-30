/**
 * TEMPORARY DIAGNOSTIC — not a permanent test. Delete once the answer is known.
 *
 * The ladder said: our full profile fails to compile
 * ("invalid data type of path filter; expected pattern, got boolean") while the
 * base policy alone runs a command fine. So one construct above the base is bad.
 * This tests each section on its own, so one CI run names the line rather than
 * the region. Control first: if `(allow default)` does not echo, the harness is
 * wrong and every other row is meaningless.
 */
import { expect, test } from "bun:test";
import { buildSandboxPolicy } from "@labunbun/agent";
import { buildSeatbeltArgs } from "../src/sandbox/seatbelt.ts";

async function run(profile: string, args: string[] = []): Promise<string> {
	const proc = Bun.spawn(["/usr/bin/sandbox-exec", "-p", profile, ...args, "--", "/bin/echo", "hello"], {
		stdout: "pipe",
		stderr: "pipe",
	});
	const [out, err, code] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	return `exit=${code} out=${JSON.stringify(out.slice(0, 80))} err=${JSON.stringify(err.trim().slice(0, 160))}`;
}

const P = (body: string) => `(version 1)\n(deny default)\n${body}\n(allow file-read*)`;

test("which construct", async () => {
	if (process.platform !== "darwin") return;
	const rows: string[] = [];
	const add = async (name: string, body: string, args: string[] = []) => {
		rows.push(`${name}: ${await run(P(body), args)}`);
	};

	rows.push(`CONTROL: ${await run("(version 1)\n(allow default)")}`);

	// The full generated profile, for the record.
	const ours = buildSeatbeltArgs(buildSandboxPolicy({ sandbox: "workspace-write", workspace: "/w" }), ["/bin/echo"]);
	rows.push(
		`FULL-OURS: ${await run(
			ours[1] ?? "",
			(ours.slice(2) as string[]).filter((a) => a !== "--"),
		)}`,
	);

	await add("tty-literal-devnull", `(allow file-read* file-write* file-ioctl (literal "/dev/null"))`);
	await add("tty-literal-ptmx", `(allow file-read* file-write* file-ioctl (literal "/dev/ptmx"))`);
	await add("tty-regex-ttys", `(allow file-ioctl (regex #"^/dev/ttys[0-9]+"))`);
	await add("pseudo-tty", `(allow pseudo-tty)`);
	await add("ipc-posix-sem", `(allow ipc-posix-sem)`);
	await add(
		"shm-three",
		`(allow ipc-posix-shm-read-data)\n(allow ipc-posix-shm-write-create)\n(allow ipc-posix-shm-write-unlink)`,
	);
	await add(
		"mach-two-globals",
		`(allow mach-lookup\n  (global-name "com.apple.system.opendirectoryd.libinfo")\n  (global-name "com.apple.PowerManagement.control"))`,
	);
	await add("network-outbound", `(allow network-outbound)\n(allow network-inbound)`);
	await add(
		"system-socket",
		`(allow system-socket\n  (require-all\n    (socket-domain AF_SYSTEM)\n    (socket-protocol 2)))`,
	);
	await add("iokit", `(allow iokit-open (iokit-registry-entry-class "RootDomainUserClient"))`);
	await add("process-info-star", `(allow process-info*)`);
	await add("writable-subpath", `(allow file-write* (subpath (param "W")))`, ["-DW=/w"]);
	await add("deny-file-read-star", `(deny file-read* file-write* (subpath (param "D")))`, ["-DD=/w/d"]);
	await add(
		"protected-ancestor",
		`(deny file-write-unlink (require-all (vnode-type DIRECTORY) (literal (param "A"))))`,
		["-DA=/w"],
	);

	expect(rows.join("\n")).toBe("ladder");
}, 180_000);
