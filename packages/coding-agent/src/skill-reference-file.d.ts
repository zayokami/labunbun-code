/**
 * A skill's reference file may be a script — the workflow skill ships one — and
 * `bundled-skills.generated.ts` imports every skill file with
 * `with { type: "file" }`, including `.js` ones. That import resolves to the
 * file's path, never to the module it contains: the script is materialized for
 * the user to read and copy, not executed from the skills tree.
 *
 * TypeScript resolves the real `.js` file and then asks for its types, so the
 * wildcard below is what makes the asset import a string. Only imports that
 * resolve to an untyped JavaScript file use it; a package's `.js` specifier
 * with its own declarations resolves normally and keeps them.
 */
declare module "*.js" {
	const path: string;
	export default path;
}
