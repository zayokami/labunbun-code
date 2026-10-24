// The syscall filter is bytes for the kernel, so the tests read the bytes back
// as a program and run them against sample `seccomp_data`. A test that only
// compared lengths would pass for a filter that refuses the wrong calls.
import { describe, expect, test } from "bun:test";
import type { ChildProcess } from "node:child_process";
import { feedSeccompFilter, SECCOMP_FD, seccompFilter } from "../src/sandbox/seccomp.ts";

const ALLOW = 0x7fff0000;
const ERRNO_ENOSYS = 0x00050000 | 38;
const KILL = 0x80000000;

const AUDIT_X64 = 0xc000003e;
const AUDIT_ARM64 = 0xc00000b7;

interface FilterData {
	readonly arch: number;
	readonly nr: number;
	readonly arg0?: number;
}

/** The instruction subset `seccompFilter` emits, interpreted the way the kernel does. */
function runFilter(program: Uint8Array, data: FilterData): number {
	const view = new DataView(program.buffer, program.byteOffset, program.byteLength);
	let accumulator = 0;
	let pc = 0;
	for (let steps = 0; steps < 10_000; steps++) {
		if (pc * 8 >= program.byteLength) throw new Error(`filter ran past its end at instruction ${pc}`);
		const code = view.getUint16(pc * 8, true);
		const jt = view.getUint8(pc * 8 + 2);
		const jf = view.getUint8(pc * 8 + 3);
		const k = view.getUint32(pc * 8 + 4, true);
		if (code === 0x20) {
			// BPF_LD | BPF_W | BPF_ABS
			const offset = k;
			if (offset === 4) accumulator = data.arch;
			else if (offset === 0) accumulator = data.nr;
			else if (offset === 16) accumulator = data.arg0 ?? 0;
			else throw new Error(`unexpected load offset ${offset}`);
			pc += 1;
			continue;
		}
		if (code === 0x15) {
			// BPF_JMP | BPF_JEQ | BPF_K
			pc += 1 + (accumulator === k ? jt : jf);
			continue;
		}
		if (code === 0x45) {
			// BPF_JMP | BPF_JSET | BPF_K
			pc += 1 + ((accumulator & k) !== 0 ? jt : jf);
			continue;
		}
		if (code === 0x06) return k; // BPF_RET | BPF_K
		throw new Error(`unexpected opcode at instruction ${pc}`);
	}
	throw new Error("filter did not return");
}

function filter(arch: string): Uint8Array {
	const program = seccompFilter(arch);
	if (program === undefined) throw new Error(`no filter for ${arch}`);
	return program;
}

describe("seccompFilter", () => {
	test("emits whole sock_filter records and begins with the architecture guard", () => {
		const program = filter("x64");
		expect(program.byteLength % 8).toBe(0);
		const view = new DataView(program.buffer);
		expect(view.getUint16(0, true)).toBe(0x20);
		expect(view.getUint32(4, true)).toBe(4);
		expect(view.getUint16(8, true)).toBe(0x15);
		expect(view.getUint32(12, true)).toBe(AUDIT_X64);
		expect(view.getUint8(10)).toBe(1);
		expect(view.getUint16(16, true)).toBe(0x06);
		expect(view.getUint32(20, true)).toBe(KILL);
	});

	test("an architecture with no syscall table gets no filter", () => {
		expect(seccompFilter("ia32")).toBeUndefined();
		expect(seccompFilter("")).toBeUndefined();
	});

	test("refuses the io_uring entry points and lets ordinary calls through on x86-64", () => {
		const program = filter("x64");
		for (const nr of [425, 426, 427]) {
			expect(runFilter(program, { arch: AUDIT_X64, nr })).toBe(ERRNO_ENOSYS);
		}
		expect(runFilter(program, { arch: AUDIT_X64, nr: 0 })).toBe(ALLOW); // read
		expect(runFilter(program, { arch: AUDIT_X64, nr: 41, arg0: 2 })).toBe(ALLOW); // socket(AF_INET)
	});

	test("refuses AF_VSOCK sockets and allows the other families", () => {
		const program = filter("x64");
		expect(runFilter(program, { arch: AUDIT_X64, nr: 41, arg0: 40 })).toBe(ERRNO_ENOSYS);
		expect(runFilter(program, { arch: AUDIT_X64, nr: 41, arg0: 1 })).toBe(ALLOW); // AF_UNIX
		expect(runFilter(program, { arch: AUDIT_X64, nr: 41, arg0: 10 })).toBe(ALLOW); // AF_INET6
	});

	test("a filter loaded on the wrong ABI kills before it can answer for the wrong table", () => {
		const program = filter("x64");
		expect(runFilter(program, { arch: AUDIT_ARM64, nr: 0 })).toBe(KILL);
		expect(runFilter(filter("arm64"), { arch: AUDIT_X64, nr: 0 })).toBe(KILL);
	});

	test("the x32 number space is killed instead of slipping past every guard", () => {
		const program = filter("x64");
		expect(runFilter(program, { arch: AUDIT_X64, nr: 0x40000000 })).toBe(KILL);
		expect(runFilter(program, { arch: AUDIT_X64, nr: 0x40000000 | 425 })).toBe(KILL);
	});

	test("the arm64 table uses the arm64 socket number and the same io_uring numbers", () => {
		const program = filter("arm64");
		expect(runFilter(program, { arch: AUDIT_ARM64, nr: 425 })).toBe(ERRNO_ENOSYS);
		expect(runFilter(program, { arch: AUDIT_ARM64, nr: 198, arg0: 40 })).toBe(ERRNO_ENOSYS);
		expect(runFilter(program, { arch: AUDIT_ARM64, nr: 198, arg0: 2 })).toBe(ALLOW);
		// 41 is x86-64's socket number; on arm64 it is an unrelated syscall.
		expect(runFilter(program, { arch: AUDIT_ARM64, nr: 41, arg0: 40 })).toBe(ALLOW);
	});
});

describe("feedSeccompFilter", () => {
	test("writes the program to fd 3 and closes it", () => {
		const written: Uint8Array[] = [];
		let ended = false;
		const sink = {
			end(chunk: Uint8Array) {
				written.push(chunk);
				ended = true;
			},
		};
		const child = { stdio: [null, null, null, sink] } as unknown as ChildProcess;
		const program = filter("x64");
		expect(feedSeccompFilter(child, program)).toBe(true);
		expect(ended).toBe(true);
		expect(written).toEqual([program]);
	});

	test("reports a spawn that did not create the descriptor", () => {
		const child = { stdio: [null, null, null] } as unknown as ChildProcess;
		expect(feedSeccompFilter(child, filter("x64"))).toBe(false);
		expect(SECCOMP_FD).toBe(3);
	});

	test("consumes the pipe error a bwrap that exited early would emit", () => {
		const listeners: Array<{ event: string; listener: () => void }> = [];
		const sink = {
			end() {},
			on(event: string, listener: () => void) {
				listeners.push({ event, listener });
			},
		};
		const child = { stdio: [null, null, null, sink] } as unknown as ChildProcess;
		expect(feedSeccompFilter(child, filter("x64"))).toBe(true);
		expect(listeners.map((entry) => entry.event)).toEqual(["error"]);
		expect(() => listeners[0]?.listener()).not.toThrow();
	});
});
