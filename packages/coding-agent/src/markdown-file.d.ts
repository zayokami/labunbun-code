/**
 * A Markdown file imported with `with { type: "file" }` resolves at runtime to a
 * path Bun can read — the real path in `bun run dev`, a `B:/~BUN/root/…` path in
 * a compiled executable. `bundled-skills.generated.ts` is the only module that
 * imports Markdown, and the value it gets is consumed by `bundled-skills.ts`.
 */
declare module "*.md" {
	const path: string;
	export default path;
}
