/**
 * A WASM file imported with `with { type: "file" }` resolves at runtime to a
 * path Bun can read — the real file under node_modules in `bun run dev`, an
 * embedded `B:/~BUN/root/…` path in a compiled executable. `repomap-wasm.ts`
 * is the only module that imports one.
 */
declare module "*.wasm" {
	const path: string;
	export default path;
}
