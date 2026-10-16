/**
 * Electron fuses — the "magic bits" an Electron binary carries so packaging
 * can turn powerful features off before code signing, after which the OS's
 * own signature validation is what keeps them off.
 *
 * The wire this reads is a sentinel string with a short header behind it:
 * one version byte, one length byte, then one state byte per fuse. Names are
 * defined for version 1 only; a longer or newer wire is still reported from
 * its states, with the unnamed tail counted rather than guessed at. A fuse
 * marked removed is a fuse the packaging tool stripped for good.
 *
 * A binary without the sentinel is not an Electron binary, and says nothing:
 * most executables on a machine are not Electron apps, and a "no fuses" line
 * on every one of their reports would be noise wearing the costume of a
 * finding.
 */

/** The sentinel string Electron embeds ahead of the fuse wire. */
export const ELECTRON_FUSE_SENTINEL = "dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX";

const SENTINEL_BYTES = Buffer.from(ELECTRON_FUSE_SENTINEL, "latin1");

/** The state byte values, together with what each one means. */
const FUSE_STATES = new Map<number, string>([
	[0x30, "disabled"],
	[0x31, "enabled"],
	[0x72, "removed"],
	// Recorded by the packaging tool as "leave alone"; never written into a
	// binary, so finding it here is more likely a damaged wire than a state.
	[0x90, "inherit"],
]);

/** Version-1 fuse names by wire index, in wire order. */
const FUSE_V1_NAMES = [
	"RunAsNode",
	"EnableCookieEncryption",
	"EnableNodeOptionsEnvironmentVariable",
	"EnableNodeCliInspectArguments",
	"EnableEmbeddedAsarIntegrityValidation",
	"OnlyLoadAppFromAsar",
	"LoadBrowserProcessSpecificV8Snapshot",
	"GrantFileProtocolExtraPrivileges",
	"WasmTrapHandlers",
];

/** Sentinels beyond this many are counted but not, one by one, listed. */
const MAX_LISTED_SENTINELS = 4;

/** Fuse bytes listed per sentinel; real wires hold a handful, not dozens. */
const MAX_LISTED_FUSES = 32;

/**
 * Report lines for the Electron fuse wires in `data`, or nothing when the
 * sentinel is absent. One sentinel is the normal case; two are a universal
 * macOS binary carrying one per slice; more are reported with that said.
 */
export function electronFuseLines(data: Buffer): string[] {
	const positions: number[] = [];
	let total = 0;
	for (let at = data.indexOf(SENTINEL_BYTES); at !== -1; at = data.indexOf(SENTINEL_BYTES, at + 1)) {
		total += 1;
		if (positions.length < MAX_LISTED_SENTINELS) positions.push(at);
	}
	if (total === 0) return [];

	const header = [`electron fuses: ${count(total, "sentinel", "sentinels")}`];
	if (total > 2) header[0] += ", more than the two a universal macOS binary carries (one per slice)";
	if (total > positions.length) header.push(`  only the first ${positions.length} are listed`);
	const lines: string[] = [];
	for (const position of positions) lines.push(...sentinelLines(data, position));
	return [...header, ...lines];
}

/** One sentinel's header and wire, from `position` to the end of its fuse bytes. */
function sentinelLines(data: Buffer, position: number): string[] {
	const label = `sentinel at ${hex(position)}`;
	const versionAt = position + SENTINEL_BYTES.length;
	if (versionAt + 1 >= data.length) {
		return [`  ${label}: the wire header (the version and length bytes) is truncated`];
	}
	const wireVersion = data[versionAt];
	const length = data[versionAt + 1];
	const wireAt = versionAt + 2;
	const remaining = data.length - wireAt;
	if (length > remaining) {
		return [
			`  ${label}: wire version ${wireVersion} declares ${count(length, "fuse", "fuses")}, ` +
				`but only ${count(remaining, "byte", "bytes")} remain in the file`,
		];
	}

	const lines = [`  ${label}: wire version ${wireVersion}, ${count(length, "fuse", "fuses")}`];
	const listed = Math.min(length, MAX_LISTED_FUSES);
	for (let i = 0; i < listed; i++) {
		const name = wireVersion === 1 && i < FUSE_V1_NAMES.length ? FUSE_V1_NAMES[i] : `fuse ${i}`;
		lines.push(`    ${name}: ${stateName(data[wireAt + i])}`);
	}
	if (length > listed)
		lines.push(`    ${count(length - listed, "further fuse byte", "further fuse bytes")} not listed`);
	return lines;
}

function stateName(state: number): string {
	return FUSE_STATES.get(state) ?? `unknown (0x${state.toString(16).padStart(2, "0")})`;
}

function hex(value: number): string {
	return `0x${value.toString(16)}`;
}

function count(n: number, singular: string, plural: string): string {
	return `${n} ${n === 1 ? singular : plural}`;
}
