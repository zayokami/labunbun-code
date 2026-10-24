// The syscall filter a bwrap command runs under, as the raw cBPF program
// bubblewrap's `--seccomp` accepts. Pure: architecture in, bytes out, so every
// claim below is testable on any machine.
// Long-form design notes: docs/dev/sandbox.md
import type { ChildProcess } from "node:child_process";

/** The descriptor bwrap reads the filter from. Fixed by the stdio layout in the two spawn sites. */
export const SECCOMP_FD = 3;

/** `struct sock_filter` is exactly these four fields, in this order. */
const INSTRUCTION_BYTES = 8;

const BPF_LD_W_ABS = 0x20;
const BPF_JMP_JEQ_K = 0x15;
const BPF_JMP_JSET_K = 0x45;
const BPF_RET_K = 0x06;

/** Return values from <linux/seccomp.h>. */
const SECCOMP_RET_KILL_PROCESS = 0x80000000;
const SECCOMP_RET_ALLOW = 0x7fff0000;
const SECCOMP_RET_ERRNO = 0x00050000;

/** `ENOSYS`: the call is reported as one this kernel does not implement. */
const ENOSYS = 38;

/** The socket family that reaches a host outside the network namespace. */
const AF_VSOCK = 40;

/** Offset of `seccomp_data.arch` and `seccomp_data.nr`. */
const DATA_ARCH_OFFSET = 4;
const DATA_NR_OFFSET = 0;
/** Offset of `seccomp_data.args[0]`, the first argument of the syscall being filtered. */
const DATA_ARG0_OFFSET = 16;

/** The `nr & 0x40000000` bit that marks the x32 ABI on x86-64. */
const X32_SYSCALL_BIT = 0x40000000;

interface FilterArchitecture {
	/** `AUDIT_ARCH_*` as the kernel writes it into `seccomp_data.arch`. */
	readonly audit: number;
	/** `io_uring_setup`, `io_uring_enter`, `io_uring_register`. */
	readonly ioUring: readonly [number, number, number];
	/** `socket`; its first argument is the address family. */
	readonly socket: number;
	/** Whether the ABI shares this architecture's number space with a high-bit variant. */
	readonly hasX32: boolean;
}

// Long-form design notes: docs/dev/sandbox.md
/**
 * The two architectures this build ships. The syscall numbers are the 64-bit
 * tables; a 32-bit process cannot run against either because the build has no
 * 32-bit target, and the x32 variant is refused below rather than mapped.
 */
const ARCHITECTURES: Record<string, FilterArchitecture> = {
	x64: { audit: 0xc000003e, ioUring: [425, 426, 427], socket: 41, hasX32: true },
	arm64: { audit: 0xc00000b7, ioUring: [425, 426, 427], socket: 198, hasX32: false },
};

interface Instruction {
	readonly code: number;
	readonly k: number;
	readonly jt?: number;
	readonly jf?: number;
}

const statement = (code: number, k: number): Instruction => ({ code, k });
const jump = (code: number, k: number, jt: number, jf: number): Instruction => ({ code, k, jt, jf });

/** The program as the little-endian records `--seccomp` reads: code, jt, jf, k. */
function encode(program: readonly Instruction[]): Uint8Array {
	const bytes = new Uint8Array(program.length * INSTRUCTION_BYTES);
	const view = new DataView(bytes.buffer);
	for (const [index, instruction] of program.entries()) {
		const at = index * INSTRUCTION_BYTES;
		view.setUint16(at, instruction.code, true);
		view.setUint8(at + 2, instruction.jt ?? 0);
		view.setUint8(at + 3, instruction.jf ?? 0);
		view.setUint32(at + 4, instruction.k >>> 0, true);
	}
	return bytes;
}

/**
 * The cBPF program for `arch`, or `undefined` when this build has no syscall
 * table for it.
 *
 * The shape is a sequence of guards that each skip their refusal when they do
 * not match; the last instruction allows whatever reached it. The architecture
 * check is first and kills on a mismatch, because every number after it is read
 * from that architecture's table: a filter built for one ABI and loaded on
 * another would either refuse unrelated calls or miss the ones it names.
 *
 * What it refuses:
 *
 * - `io_uring_setup`, `io_uring_enter`, `io_uring_register`. io_uring is a
 *   second I/O entry path beside the read/write family, with its own history of
 *   kernel defects. Nothing in a coding session needs it, and a sandbox is
 *   better off with one fewer ring to audit.
 * - `socket` with `AF_VSOCK`. A network namespace owns the IP stack, not the
 *   hypervisor's socket family, so a vsock connection is a route off the
 *   machine that `--unshare-net` cannot close.
 *
 * It deliberately allows `AF_UNIX`, unlike a stricter design: the loopback
 * bridge is a Unix socket, and the bridge process inherits this filter. That
 * leaves host Unix sockets reachable through the read-only `/` bind; the
 * sandbox's network axis is not a complete socket wall until the bridge has a
 * transport that does not need `AF_UNIX`.
 *
 * `ENOSYS` rather than `EPERM` is the refusal: a runtime that probes io_uring
 * at start-up reads it as "this kernel does not have it" and takes the path it
 * already has, instead of surfacing a policy error for a call it never asked
 * the user about.
 */
export function seccompFilter(arch: string): Uint8Array | undefined {
	const table = ARCHITECTURES[arch];
	if (table === undefined) return undefined;

	const program: Instruction[] = [
		statement(BPF_LD_W_ABS, DATA_ARCH_OFFSET),
		jump(BPF_JMP_JEQ_K, table.audit, 1, 0),
		statement(BPF_RET_K, SECCOMP_RET_KILL_PROCESS),
		statement(BPF_LD_W_ABS, DATA_NR_OFFSET),
	];

	// The x32 ABI shares AUDIT_ARCH_X86_64 and sets a bit in the syscall number.
	// Its calls would miss every number below, so the bit is a kill before the
	// guards start rather than an allow at the end.
	if (table.hasX32) {
		program.push(jump(BPF_JMP_JSET_K, X32_SYSCALL_BIT, 0, 1), statement(BPF_RET_K, SECCOMP_RET_KILL_PROCESS));
	}

	for (const number of table.ioUring) {
		program.push(jump(BPF_JMP_JEQ_K, number, 0, 1), statement(BPF_RET_K, SECCOMP_RET_ERRNO | ENOSYS));
	}

	// A socket call carries its family in `args[0]`. Any other syscall skips
	// the argument read and the family guard in one jump and is allowed.
	program.push(
		jump(BPF_JMP_JEQ_K, table.socket, 0, 4),
		statement(BPF_LD_W_ABS, DATA_ARG0_OFFSET),
		jump(BPF_JMP_JEQ_K, AF_VSOCK, 0, 1),
		statement(BPF_RET_K, SECCOMP_RET_ERRNO | ENOSYS),
		statement(BPF_RET_K, SECCOMP_RET_ALLOW),
		statement(BPF_RET_K, SECCOMP_RET_ALLOW),
	);

	return encode(program);
}

/**
 * Put `program` on the child's {@link SECCOMP_FD} and close that end.
 *
 * The child is bwrap, which reads the descriptor to EOF while parsing its
 * arguments, so the write is what unblocks it. Returns false when the spawn did
 * not create the pipe the argv names; the caller owns the child and should end
 * it, because running on without the filter is exactly what the flag exists to
 * prevent.
 */
export function feedSeccompFilter(child: ChildProcess, program: Uint8Array): boolean {
	const sink = child.stdio[SECCOMP_FD];
	if (sink === null || sink === undefined || typeof (sink as { end?: unknown }).end !== "function") return false;
	// The far end of the pipe belongs to bwrap. A bwrap that exits before it
	// reads the whole program reports that asynchronously as an error event on
	// this stream, and a stream error with no listener takes the host process
	// down. The child's own exit path reports the failure, so the event is
	// consumed here rather than surfaced twice.
	(sink as { on?: (event: string, listener: () => void) => unknown }).on?.("error", () => {});
	try {
		(sink as { end(chunk: Uint8Array): void }).end(program);
	} catch {
		return false;
	}
	return true;
}
