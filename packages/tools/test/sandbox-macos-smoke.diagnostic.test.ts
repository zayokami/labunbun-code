/**
 * TEMPORARY DIAGNOSTIC — not a permanent test. Delete once the answer is known.
 *
 * Established, all under the same `workspace-write` policy:
 *   /bin/echo MARKER-BINARY   exit=0 out="MARKER-BINARY\n"   ← exec works
 *   bun -e 'console.log(1)'   exit=0 out=""                   ← bun dies at startup
 *   bun noisy.js              exit=0 out=""  and no ran.txt  ← never reaches user code
 *
 * `BASE_POLICY` opens `(deny default)` and emits no sysctl rule, so every
 * sysctl a runtime queries while initialising is refused. `/bin/echo` queries
 * none and survives; bun's JSC queries several and does not. That is a
 * hypothesis, so: the same command under the unmodified profile (control), the
 * profile plus Codex's enumerated `sysctl-name` list, and the profile plus a
 * bare `(allow sysctl-read)`. If the second runs and the first does not, the
 * enumeration is the fix and the third tells us whether it has to be that list.
 */
import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultOperations } from "@labunbun/tools";
import { buildSeatbeltArgs } from "../src/sandbox/seatbelt.ts";
import { workspacePolicy } from "../src/sandbox/workspace-policy.ts";

/**
 * A subset of Codex's list (`seatbelt_base_policy.sbpl:24-76`), trimmed of the
 * entries that are obviously irrelevant to starting a process — cache config
 * probing, routing tables, `kern.secure_kernel`. This rung is a positive test:
 * if a subset is enough then sysctl is the class of blocker, and the fix is to
 * restore the list verbatim rather than to keep a guess at which entries matter.
 */
const CODEX_SYSCTL = `(allow sysctl-read
  (sysctl-name "hw.activecpu")
  (sysctl-name "hw.byteorder")
  (sysctl-name "hw.cachelinesize_compat")
  (sysctl-name "hw.cputype")
  (sysctl-name "hw.l1dcachesize_compat")
  (sysctl-name "hw.l1icachesize_compat")
  (sysctl-name "hw.l2cachesize_compat")
  (sysctl-name "hw.l3cachesize_compat")
  (sysctl-name "hw.logicalcpu_max")
  (sysctl-name "hw.machine")
  (sysctl-name "hw.memsize")
  (sysctl-name "hw.ncpu")
  (sysctl-name "hw.nperflevels")
  (sysctl-name "hw.packages")
  (sysctl-name "hw.pagesize")
  (sysctl-name "hw.physicalcpu")
  (sysctl-name "hw.physicalcpu_max")
  (sysctl-name "hw.logicalcpu")
  (sysctl-name "hw.cpufrequency")
  (sysctl-name "kern.argmax")
  (sysctl-name "kern.hostname")
  (sysctl-name "kern.maxfilesperproc")
  (sysctl-name "kern.maxproc")
  (sysctl-name "kern.osproductversion")
  (sysctl-name "kern.osrelease")
  (sysctl-name "kern.ostype")
  (sysctl-name "kern.osversion")
  (sysctl-name "kern.sysv.semmns")
  (sysctl-name "kern.usrstack64")
  (sysctl-name "kern.version")
  (sysctl-name "vm.loadavg")
  (sysctl-name-prefix "hw.optional.arm.")
  (sysctl-name-prefix "hw.perflevel")
  (sysctl-name-prefix "kern.proc.pgrp.")
  (sysctl-name-prefix "kern.proc.pid."))
(allow sysctl-write (sysctl-name "kern.grade_cputype"))`;

const BARE_SYSCTL = `(allow sysctl-read)`;

test("which sysctl rule makes bun start", async () => {
	if (process.platform !== "darwin") return;
	const rows: string[] = [];
	const cwd = mkdtempSync(join(tmpdir(), "lbb-sysctl-"));
	const policy = await workspacePolicy(cwd, { sandbox: "workspace-write" });
	const command = ["/bin/bash", "-c", `${process.execPath} -e 'console.log("MARKER-E")'`];

	async function profile(label: string, extra: string): Promise<void> {
		// Forward the production argv untouched and only splice the profile text.
		// Reassembling it by position is how the first two versions of this
		// diagnostic dropped the -D params and started reporting a compile error.
		const args = buildSeatbeltArgs(policy, command);
		if (extra.length > 0) args[1] = `${args[1]}\n${extra}`;
		try {
			const proc = Bun.spawn(["/usr/bin/sandbox-exec", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
			const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
			rows.push(`${label}: exit=${await proc.exited} out=${JSON.stringify(out)} err=${JSON.stringify(err)}`);
		} catch (e) {
			rows.push(`${label}: THREW ${e instanceof Error ? e.message : String(e)}`);
		}
	}

	await profile("CONTROL-UNMODIFIED", "");
	await profile("WITH-CODEX-SYSCTL", CODEX_SYSCTL);
	await profile("WITH-BARE-SYSCTL", BARE_SYSCTL);

	// The tool path end to end, so a green rung above is known to reach the
	// assertion that has been failing rather than only a hand-built argv.
	const ops = defaultOperations();
	const toolResult = await ops.exec({
		command: `${process.execPath} -e 'console.log("MARKER-TOOL")'`,
		cwd,
		timeoutMs: 60_000,
		signal: new AbortController().signal,
		sandbox: policy,
		onOutput: () => {},
	});
	rows.push(`TOOL: exit=${toolResult.exitCode} out=${JSON.stringify(toolResult.stdout)}`);

	expect(rows.join("\n")).toBe("table");
}, 300_000);
