/**
 * TEMPORARY DIAGNOSTIC — not a permanent test. Delete once the answer is known.
 *
 * The spill test on macOS reports a real command exiting 0 with no output under
 * the profile this build generates. This runs the same command by hand under a
 * ladder of profiles, from "allow everything" up to ours, so one CI run says
 * which rung breaks. Control first: if `(allow default)` does not echo, the
 * harness is wrong and every other row is meaningless.
 */
import { expect, test } from "bun:test";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildSandboxPolicy } from "@labunbun/agent";
import { buildSeatbeltArgs } from "../src/sandbox/seatbelt.ts";

const SYSCTL = `(allow sysctl-read
  (sysctl-name "hw.activecpu") (sysctl-name "hw.byteorder")
  (sysctl-name "hw.cpufamily") (sysctl-name "hw.cputype")
  (sysctl-name "hw.l1dcachesize_compat") (sysctl-name "hw.l1icachesize_compat")
  (sysctl-name "hw.l2cachesize_compat") (sysctl-name "hw.l3cachesize_compat")
  (sysctl-name "hw.logicalcpu_max") (sysctl-name "hw.machine")
  (sysctl-name "hw.memsize") (sysctl-name "hw.ncpu")
  (sysctl-name "hw.nperflevels") (sysctl-name-prefix "hw.optional.arm.")
  (sysctl-name-prefix "hw.optional.armv8_") (sysctl-name "hw.packages")
  (sysctl-name "hw.pagesize_compat") (sysctl-name "hw.pagesize")
  (sysctl-name "hw.physicalcpu") (sysctl-name "hw.physicalcpu_max")
  (sysctl-name "hw.logicalcpu") (sysctl-name "hw.cpufrequency")
  (sysctl-name "hw.tbfrequency_compat") (sysctl-name "hw.vectorunit")
  (sysctl-name "machdep.cpu.brand_string") (sysctl-name "kern.argmax")
  (sysctl-name "kern.hostname") (sysctl-name "kern.maxfilesperproc")
  (sysctl-name "kern.maxproc") (sysctl-name "kern.osproductversion")
  (sysctl-name "kern.osrelease") (sysctl-name "kern.ostype")
  (sysctl-name "kern.osvariant_status") (sysctl-name "kern.osversion")
  (sysctl-name "kern.secure_kernel") (sysctl-name "kern.sysv.semmns")
  (sysctl-name "kern.usrstack64") (sysctl-name "kern.version")
  (sysctl-name "sysctl.proc_cputype") (sysctl-name "vm.loadavg")
  (sysctl-name-prefix "hw.perflevel") (sysctl-name-prefix "kern.proc.pgrp.")
  (sysctl-name-prefix "kern.proc.pid.") (sysctl-name-prefix "net.routetable."))
(allow sysctl-write (sysctl-name "kern.grade_cputype"))`;

const CONTROL = `(version 1)\n(allow default)`;

const RUNG = (extra: string) => `(version 1)\n(deny default)\n${extra}\n(allow file-read*)`;

async function run(profile: string, command: string[]): Promise<string> {
	const proc = Bun.spawn(["/usr/bin/sandbox-exec", "-p", profile, "--", ...command], {
		stdout: "pipe",
		stderr: "pipe",
	});
	const [out, err, code] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	return `exit=${code} stdout=${JSON.stringify(out.slice(0, 200))} stderr=${JSON.stringify(err.slice(0, 300))}`;
}

test("ladder", async () => {
	if (process.platform !== "darwin") return;
	const rows: string[] = [];
	rows.push(`CONTROL allow-default: ${await run(CONTROL, ["/bin/echo", "hello"])}`);

	const tmp = realpathSync(mkdtempSync(join(tmpdir(), "lbb-smoke-")));
	const policy = buildSandboxPolicy({ sandbox: "workspace-write", workspace: tmp });
	const ours = buildSeatbeltArgs(policy, ["/bin/echo", "hello"]);
	const ourProfile = ours[1] ?? "";

	// Rung by rung: which addition makes a real command print again.
	const base = ourProfile.split("\n(allow file-read*)")[0] ?? "";
	rows.push(`OURS echo: ${await run(ourProfile, ["/bin/echo", "hello"])}`);
	rows.push(`OURS bun: ${await run(ourProfile, [process.execPath, "-e", "console.log('hi')"])}`);
	rows.push(`BASE-ONLY echo: ${await run(`${base}\n(allow file-read*)`, ["/bin/echo", "hello"])}`);
	rows.push(`BASE+SYSCTL echo: ${await run(`${base}\n(allow file-read*)\n${SYSCTL}`, ["/bin/echo", "hello"])}`);
	rows.push(
		`BASE+SYSCTL bun: ${await run(`${base}\n(allow file-read*)\n${SYSCTL}`, [process.execPath, "-e", "console.log('hi')"])}`,
	);

	expect(rows.join("\n\n")).toBe("ladder");
}, 120_000);
