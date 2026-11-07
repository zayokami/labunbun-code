// Per-language tag rules for the repository map: which node types declare a
// name, and where a call names the thing it reaches. Every grammar in
// `@vscode/tree-sitter-wasm` exposes the same tree-sitter API but its own node
// vocabulary, so the rules live beside each other here rather than in the walk
// that applies them.
//
// The TypeScript/JavaScript rules are the ones P1 shipped. Python, Go, Rust,
// Java, C#, C++, Ruby, PHP, Bash and PowerShell follow the same shape (Aider's
// tag queries where it has them) so the graph and the ranker do not need a
// language concept of their own. CSS and INI are deliberately absent: a
// stylesheet or an ini file has no call graph, only names, and listing those
// names would spend the token budget without ranking anything.
//
// Long-form design notes: docs/dev/repomap.md (P3).
import type { Node as SyntaxNode } from "web-tree-sitter";

/** Every grammar a map knows. TSX is a separate grammar from TypeScript. */
export type RepoMapLanguage =
	| "typescript"
	| "tsx"
	| "javascript"
	| "python"
	| "go"
	| "rust"
	| "java"
	| "c-sharp"
	| "cpp"
	| "ruby"
	| "php"
	| "bash"
	| "powershell";

export const REPO_MAP_LANGUAGES: readonly RepoMapLanguage[] = [
	"typescript",
	"tsx",
	"javascript",
	"python",
	"go",
	"rust",
	"java",
	"c-sharp",
	"cpp",
	"ruby",
	"php",
	"bash",
	"powershell",
];

/**
 * The extensions a map parses, without the dot.
 *
 * The glob spells each one twice, in lower and upper case: `Bun.Glob` matches
 * case-sensitively while `repoMapLanguageFor` lowercases, and a checkout with
 * `foo.C`, `foo.H` (common for C/C++ on Windows) or a renamed `.PY` file must
 * not disappear from the map.
 */
const REPO_MAP_CODE_EXTENSIONS = [
	"ts",
	"tsx",
	"mts",
	"cts",
	"js",
	"jsx",
	"mjs",
	"cjs",
	"py",
	"go",
	"rs",
	"java",
	"cs",
	"cpp",
	"cc",
	"cxx",
	"hpp",
	"hh",
	"hxx",
	"c",
	"h",
	"rb",
	"rake",
	"php",
	"sh",
	"bash",
	"ps1",
	"psm1",
	"psd1",
] as const;

/** The files a map considers. Shared with the small-repository threshold, which must count the same set. */
export const REPO_MAP_CODE_FILES = new Bun.Glob(
	`**/*.{${REPO_MAP_CODE_EXTENSIONS.flatMap((extension) => [extension, extension.toUpperCase()]).join(",")}}`,
);

/** The grammar for a path, or null when the extension is not one a map parses. */
export function repoMapLanguageFor(path: string): RepoMapLanguage | null {
	const dot = path.lastIndexOf(".");
	if (dot === -1) return null;
	switch (path.slice(dot).toLowerCase()) {
		case ".ts":
		case ".mts":
		case ".cts":
			return "typescript";
		case ".tsx":
			return "tsx";
		case ".js":
		case ".jsx":
		case ".mjs":
		case ".cjs":
			return "javascript";
		case ".py":
			return "python";
		case ".go":
			return "go";
		case ".rs":
			return "rust";
		case ".java":
			return "java";
		case ".cs":
			return "c-sharp";
		// The C++ grammar parses C as well; one grammar keeps the graph whole.
		case ".cpp":
		case ".cc":
		case ".cxx":
		case ".hpp":
		case ".hh":
		case ".hxx":
		case ".c":
		case ".h":
			return "cpp";
		case ".rb":
		case ".rake":
			return "ruby";
		case ".php":
			return "php";
		case ".sh":
		case ".bash":
			return "bash";
		case ".ps1":
		case ".psm1":
		case ".psd1":
			return "powershell";
		default:
			return null;
	}
}

export type RepoMapTagDefinitionKind = "function" | "class" | "interface" | "type" | "enum" | "method";

export interface RepoMapTagDefinition {
	name: string;
	kind: RepoMapTagDefinitionKind;
}

/** How one grammar's nodes become definition and reference tags. */
export interface RepoMapTagRules {
	/** The declaration a node spells out, or null. */
	definition(node: SyntaxNode): RepoMapTagDefinition | null;
	/** The name a call node reaches, or null. */
	reference(node: SyntaxNode): string | null;
}

// ---------------------------------------------------------------------------
// TypeScript / JavaScript
// ---------------------------------------------------------------------------

const JS_DECLARATION_KINDS: Record<string, RepoMapTagDefinitionKind> = {
	function_declaration: "function",
	generator_function_declaration: "function",
	function_expression: "function",
	generator_function: "function",
	class_declaration: "class",
	abstract_class_declaration: "class",
	class: "class",
	interface_declaration: "interface",
	type_alias_declaration: "type",
	enum_declaration: "enum",
	function_signature: "function",
	method_definition: "method",
	method_signature: "method",
};

const JS_FUNCTION_VALUES = new Set(["arrow_function", "function_expression", "generator_function"]);

function nameOf(node: SyntaxNode): string | null {
	const name = node.childForFieldName("name");
	return name ? name.text : null;
}

function jsDefinition(node: SyntaxNode): RepoMapTagDefinition | null {
	switch (node.type) {
		case "method_definition": {
			const name = nameOf(node);
			// A constructor is reachable through its class, which is already a tag.
			return name && name !== "constructor" ? { name, kind: "method" } : null;
		}
		case "variable_declarator": {
			// `const f = () => …`, `const f = function () { … }` and `const C = class {}`.
			const value = node.childForFieldName("value");
			if (!value) return null;
			const kind: RepoMapTagDefinitionKind | undefined =
				value.type === "class" ? "class" : JS_FUNCTION_VALUES.has(value.type) ? "function" : undefined;
			if (!kind) return null;
			const name = node.childForFieldName("name");
			return name?.type === "identifier" ? { name: name.text, kind } : null;
		}
		case "public_field_definition": {
			// `handler = () => …` and `Child = class {}` inside a class body.
			const value = node.childForFieldName("value");
			if (!value) return null;
			const kind: RepoMapTagDefinitionKind | undefined =
				value.type === "class" ? "class" : JS_FUNCTION_VALUES.has(value.type) ? "method" : undefined;
			const name = node.childForFieldName("name");
			if (!kind || name?.type !== "property_identifier") return null;
			return { name: name.text, kind };
		}
		case "assignment_expression": {
			// `module.exports.f = () => …` and `exports.f = function () { … }`.
			const right = node.childForFieldName("right");
			if (!right || !(JS_FUNCTION_VALUES.has(right.type) || right.type === "class")) return null;
			const kind: RepoMapTagDefinitionKind = right.type === "class" ? "class" : "function";
			const left = node.childForFieldName("left");
			if (!left) return null;
			if (left.type === "identifier") return { name: left.text, kind };
			if (left.type === "member_expression") {
				const object = left.childForFieldName("object");
				const property = left.childForFieldName("property");
				// `module.exports = …` declares no name called `exports`; the export
				// target can only be read through the property.
				if (object?.type === "identifier" && object.text === "module" && property?.text === "exports") return null;
				if (property?.type === "property_identifier") return { name: property.text, kind };
			}
			return null;
		}
		default: {
			const kind = JS_DECLARATION_KINDS[node.type];
			if (!kind) return null;
			const name = nameOf(node);
			return name ? { name, kind } : null;
		}
	}
}

function jsCalleeName(node: SyntaxNode): string | null {
	if (node.type === "identifier") return node.text === "require" ? null : node.text;
	if (node.type === "member_expression") {
		const property = node.childForFieldName("property");
		if (property?.type === "property_identifier") return property.text;
		if (property?.type === "private_property_identifier") return property.text;
	}
	return null;
}

function jsReference(node: SyntaxNode): string | null {
	switch (node.type) {
		case "call_expression": {
			const fn = node.childForFieldName("function");
			return fn ? jsCalleeName(fn) : null;
		}
		case "new_expression": {
			const constructorNode = node.childForFieldName("constructor");
			return constructorNode ? jsCalleeName(constructorNode) : null;
		}
		// A component used in JSX is a reference in every sense the map cares
		// about: it is the main way a React file reaches another file's exports.
		case "jsx_opening_element":
		case "jsx_self_closing_element": {
			const name = node.childForFieldName("name");
			return name ? jsxElementName(name) : null;
		}
		default:
			return null;
	}
}

/** The component a JSX tag names; lower-case tags are intrinsic DOM elements. */
function jsxElementName(node: SyntaxNode): string | null {
	switch (node.type) {
		case "identifier":
			return /^[A-Z]/.test(node.text) ? node.text : null;
		case "member_expression":
			return node.childForFieldName("property")?.text ?? null;
		default:
			return null;
	}
}

// ---------------------------------------------------------------------------
// Python
// ---------------------------------------------------------------------------

const PYTHON_DECLARATIONS: Record<string, RepoMapTagDefinitionKind> = {
	function_definition: "function",
	class_definition: "class",
};

/** Python has one call node; the callee is an identifier or an attribute (`obj.method`). */
function pythonReference(node: SyntaxNode): string | null {
	if (node.type !== "call") return null;
	const fn = node.childForFieldName("function");
	if (!fn) return null;
	if (fn.type === "identifier") return fn.text;
	if (fn.type === "attribute") return fn.childForFieldName("attribute")?.text ?? null;
	return null;
}

// ---------------------------------------------------------------------------
// Go
// ---------------------------------------------------------------------------

const GO_DECLARATIONS: Record<string, RepoMapTagDefinitionKind> = {
	function_declaration: "function",
	method_declaration: "method",
	// `type Box struct { … }` and `type Row interface { … }`: one kind is enough,
	// because the map only uses the name.
	type_spec: "class",
};

/** `f()` is an identifier; `obj.Method()` is a selector expression. */
function goReference(node: SyntaxNode): string | null {
	if (node.type !== "call_expression") return null;
	const fn = node.childForFieldName("function");
	if (!fn) return null;
	if (fn.type === "identifier") return fn.text;
	if (fn.type === "selector_expression") return fn.childForFieldName("field")?.text ?? null;
	return null;
}

// ---------------------------------------------------------------------------
// Rust
// ---------------------------------------------------------------------------

const RUST_DECLARATIONS: Record<string, RepoMapTagDefinitionKind> = {
	function_item: "function",
	// A trait's body-less method: `fn area(&self) -> f64;`.
	function_signature_item: "method",
	struct_item: "class",
	enum_item: "enum",
	trait_item: "interface",
	type_item: "type",
};

/** `f()`, `self.method()`, `Thing::new()` and `foo::<T>()` all reach one name. */
function rustCallee(node: SyntaxNode): string | null {
	switch (node.type) {
		case "identifier":
			return node.text;
		case "field_expression": {
			const field = node.childForFieldName("field");
			return field ? field.text : null;
		}
		case "scoped_identifier": {
			const name = node.childForFieldName("name");
			return name ? name.text : null;
		}
		case "generic_function": {
			const fn = node.childForFieldName("function");
			return fn ? rustCallee(fn) : null;
		}
		default:
			return null;
	}
}

function rustReference(node: SyntaxNode): string | null {
	if (node.type !== "call_expression") return null;
	const fn = node.childForFieldName("function");
	return fn ? rustCallee(fn) : null;
}

// ---------------------------------------------------------------------------
// Java
// ---------------------------------------------------------------------------

const JAVA_DECLARATIONS: Record<string, RepoMapTagDefinitionKind> = {
	class_declaration: "class",
	interface_declaration: "interface",
	// `@interface` is the source spelling of an annotation type.
	annotation_type_declaration: "interface",
	enum_declaration: "enum",
	record_declaration: "class",
	method_declaration: "method",
};

/** The type of a `new X()`: a name, possibly generic or qualified. */
function javaTypeName(node: SyntaxNode): string | null {
	switch (node.type) {
		case "identifier":
		case "type_identifier":
			return node.text;
		case "generic_type": {
			const type = node.namedChildren.find((child) => child && child.type !== "type_arguments");
			return type ? javaTypeName(type) : null;
		}
		// `java.util.ArrayList` has no `name` field in this grammar; the last
		// segment is the type, whatever the scope nested inside it.
		case "scoped_identifier":
		case "scoped_type_identifier": {
			const names = node.namedChildren.filter((child) => child !== null);
			const last = names.length > 0 ? names[names.length - 1] : null;
			return last ? javaTypeName(last) : null;
		}
		default:
			return null;
	}
}

/** `f()` and `obj.f()` both name `f` in the invocation's `name` field. */
function javaReference(node: SyntaxNode): string | null {
	switch (node.type) {
		case "method_invocation":
			return node.childForFieldName("name")?.text ?? null;
		case "object_creation_expression": {
			const type = node.childForFieldName("type");
			return type ? javaTypeName(type) : null;
		}
		// `@Marker` and `@Marker(value)` reach the annotation type's file.
		case "marker_annotation":
		case "annotation": {
			const name = node.childForFieldName("name");
			return name ? javaTypeName(name) : null;
		}
		default:
			return null;
	}
}

// ---------------------------------------------------------------------------
// C#
// ---------------------------------------------------------------------------

const CSHARP_DECLARATIONS: Record<string, RepoMapTagDefinitionKind> = {
	class_declaration: "class",
	interface_declaration: "interface",
	enum_declaration: "enum",
	struct_declaration: "class",
	record_declaration: "class",
	method_declaration: "method",
	// A property is a member like a method; the map does not distinguish them.
	property_declaration: "method",
	// A delegate declares a type, not a callable implementation.
	delegate_declaration: "type",
};

/** A created type can be generic (`Widget<int>`) or qualified (`App.Widget`). */
function csharpTypeName(node: SyntaxNode): string | null {
	switch (node.type) {
		case "identifier":
			return node.text;
		case "generic_name":
			return node.namedChildren.find((child) => child?.type === "identifier")?.text ?? null;
		case "qualified_name": {
			const name = node.childForFieldName("name");
			return name ? csharpTypeName(name) : null;
		}
		default:
			return null;
	}
}

/** The name an invocation reaches: `f()`, `obj.f()`, `f<int>()` or `obj.f<int>()`. */
function csharpCalleeName(node: SyntaxNode): string | null {
	switch (node.type) {
		case "identifier":
			return node.text;
		case "generic_name":
			return csharpTypeName(node);
		case "member_access_expression": {
			const name = node.childForFieldName("name");
			return name ? csharpTypeName(name) : null;
		}
		default:
			return null;
	}
}

function csharpReference(node: SyntaxNode): string | null {
	switch (node.type) {
		case "invocation_expression": {
			const fn = node.childForFieldName("function");
			return fn ? csharpCalleeName(fn) : null;
		}
		case "object_creation_expression": {
			const type = node.childForFieldName("type");
			return type ? csharpTypeName(type) : null;
		}
		default:
			return null;
	}
}

// ---------------------------------------------------------------------------
// C++
// ---------------------------------------------------------------------------

const CPP_DECLARATIONS: Record<string, RepoMapTagDefinitionKind> = {
	class_specifier: "class",
	struct_specifier: "class",
	union_specifier: "class",
	enum_specifier: "enum",
};

/** The wrappers `cppDeclaratorName` has to look through to reach a name. */
const CPP_DECLARATOR_WRAPPERS = new Set([
	"function_declarator",
	"pointer_declarator",
	"reference_declarator",
	"parenthesized_declarator",
	"array_declarator",
]);

/** Strip the declarator wrappers so `int *A::f()` reaches the identifier. */
function cppDeclaratorName(node: SyntaxNode): string | null {
	let current = node;
	for (;;) {
		// Most wrappers expose the declarator as a field; `reference_declarator`
		// does not (`(reference_declarator (function_declarator …))`), so fall
		// back to a named child of a wrapper type. A function returning a
		// reference is otherwise invisible to the map.
		const inner =
			current.childForFieldName("declarator") ??
			current.namedChildren.find((child) => child && CPP_DECLARATOR_WRAPPERS.has(child.type));
		if (!inner || inner === current) break;
		current = inner;
	}
	switch (current.type) {
		case "identifier":
		case "field_identifier":
		case "operator_name":
			return current.text;
		case "destructor_name":
			return current.text;
		case "qualified_identifier":
			return current.childForFieldName("name")?.text ?? null;
		default:
			return null;
	}
}

/** Whether a declarator spells a function rather than a variable. */
function cppIsFunctionDeclarator(node: SyntaxNode): boolean {
	let current = node;
	for (;;) {
		if (current.type === "function_declarator" || current.type === "destructor_name") return true;
		const inner =
			current.childForFieldName("declarator") ??
			current.namedChildren.find((child) => child && CPP_DECLARATOR_WRAPPERS.has(child.type));
		if (!inner || inner === current) return false;
		current = inner;
	}
}

function cppDefinition(node: SyntaxNode): RepoMapTagDefinition | null {
	switch (node.type) {
		case "function_definition": {
			const declarator = node.childForFieldName("declarator");
			const name = declarator ? cppDeclaratorName(declarator) : null;
			return name ? { name, kind: "function" } : null;
		}
		// A prototype declares the same name the definition later spells out:
		// `int area() const;` in a header, `int Box::area() { … }` in a source
		// file. A plain variable declaration has no function declarator.
		case "declaration":
		case "field_declaration": {
			const declarator = node.childForFieldName("declarator");
			if (!declarator || !cppIsFunctionDeclarator(declarator)) return null;
			const name = cppDeclaratorName(declarator);
			if (!name) return null;
			return { name, kind: node.parent?.type === "field_declaration_list" ? "method" : "function" };
		}
		case "preproc_function_def": {
			const name = node.childForFieldName("name");
			return name ? { name: name.text, kind: "function" } : null;
		}
		// An object-like macro names a constant; `type` is the nearest kind the
		// map has for a value that is not callable.
		case "preproc_def": {
			const name = node.childForFieldName("name");
			return name ? { name: name.text, kind: "type" } : null;
		}
		default: {
			const kind = CPP_DECLARATIONS[node.type];
			if (!kind) return null;
			const name = node.childForFieldName("name");
			return name ? { name: name.text, kind } : null;
		}
	}
}

/** `f()`, `obj.f()`, `A::f()` and the templated forms all name one callee. */
function cppCallee(node: SyntaxNode): string | null {
	switch (node.type) {
		case "identifier":
		case "field_identifier":
			return node.text;
		case "field_expression":
			return node.childForFieldName("field")?.text ?? null;
		case "qualified_identifier":
		case "template_function":
		case "template_method":
			return node.childForFieldName("name")?.text ?? null;
		default:
			return null;
	}
}

function cppReference(node: SyntaxNode): string | null {
	switch (node.type) {
		case "call_expression": {
			const fn = node.childForFieldName("function");
			return fn ? cppCallee(fn) : null;
		}
		case "new_expression": {
			const type = node.childForFieldName("type");
			return type?.type === "type_identifier" ? type.text : null;
		}
		default:
			return null;
	}
}

// ---------------------------------------------------------------------------
// Ruby
// ---------------------------------------------------------------------------

function rubyDefinition(node: SyntaxNode): RepoMapTagDefinition | null {
	switch (node.type) {
		case "method":
		case "singleton_method": {
			const name = node.childForFieldName("name");
			return name ? { name: name.text, kind: "method" } : null;
		}
		case "class":
		case "module": {
			// A module is reachable the same way a class is, and the map has no
			// separate kind for it.
			const name = node.childForFieldName("name");
			return name ? { name: name.text, kind: "class" } : null;
		}
		default:
			return null;
	}
}

/** Ruby puts every call under one node; the method field is the name. */
function rubyReference(node: SyntaxNode): string | null {
	if (node.type !== "call") return null;
	const name = node.childForFieldName("method");
	return name ? name.text : null;
}

// ---------------------------------------------------------------------------
// PHP
// ---------------------------------------------------------------------------

function phpNamed(node: SyntaxNode, kind: RepoMapTagDefinitionKind): RepoMapTagDefinition | null {
	const name = node.childForFieldName("name");
	return name ? { name: name.text, kind } : null;
}

function phpDefinition(node: SyntaxNode): RepoMapTagDefinition | null {
	switch (node.type) {
		case "class_declaration":
		case "trait_declaration":
			return phpNamed(node, "class");
		case "interface_declaration":
			return phpNamed(node, "interface");
		case "enum_declaration":
			return phpNamed(node, "enum");
		case "function_definition":
			return phpNamed(node, "function");
		case "method_declaration": {
			const name = node.childForFieldName("name")?.text;
			// A constructor is reachable through its class, which is already a tag.
			if (!name || name === "__construct") return null;
			return { name, kind: "method" };
		}
		default:
			return null;
	}
}

/** The last segment of a possibly qualified name: `\App\Sub\helper` names `helper`. */
function phpNameText(node: SyntaxNode): string | null {
	switch (node.type) {
		case "name":
			return node.text;
		case "qualified_name": {
			const names = node.namedChildren.filter((child) => child?.type === "name");
			const last = names.length > 0 ? names[names.length - 1] : null;
			return last ? last.text : null;
		}
		default:
			return null;
	}
}

function phpReference(node: SyntaxNode): string | null {
	switch (node.type) {
		case "function_call_expression": {
			const fn = node.childForFieldName("function");
			return fn ? phpNameText(fn) : null;
		}
		// `$obj->f()` and `$obj?->f()` reach the same name.
		case "member_call_expression":
		case "nullsafe_member_call_expression":
		case "scoped_call_expression":
			return node.childForFieldName("name")?.text ?? null;
		case "object_creation_expression": {
			const type = node.namedChildren.find(
				(child) => child && (child.type === "name" || child.type === "qualified_name"),
			);
			return type ? phpNameText(type) : null;
		}
		default:
			return null;
	}
}

// ---------------------------------------------------------------------------
// Bash
// ---------------------------------------------------------------------------

/** Both `f() { … }` and `function f { … }` are `function_definition`. */
function bashDefinition(node: SyntaxNode): RepoMapTagDefinition | null {
	if (node.type !== "function_definition") return null;
	const name = node.childForFieldName("name");
	return name ? { name: name.text, kind: "function" } : null;
}

/** A shell call is a command; builtins land here too and match only if defined. */
function bashReference(node: SyntaxNode): string | null {
	if (node.type !== "command") return null;
	return node.childForFieldName("name")?.text ?? null;
}

// ---------------------------------------------------------------------------
// PowerShell
// ---------------------------------------------------------------------------

function powershellSimpleName(node: SyntaxNode): string | null {
	const name = node.namedChildren.find((child) => child?.type === "simple_name");
	return name ? name.text : null;
}

function powershellDefinition(node: SyntaxNode): RepoMapTagDefinition | null {
	switch (node.type) {
		case "function_statement": {
			const name = node.namedChildren.find((child) => child?.type === "function_name");
			return name ? { name: name.text, kind: "function" } : null;
		}
		case "class_statement": {
			const name = powershellSimpleName(node);
			return name ? { name, kind: "class" } : null;
		}
		case "enum_statement": {
			const name = powershellSimpleName(node);
			return name ? { name, kind: "enum" } : null;
		}
		case "class_method_definition": {
			const name = powershellSimpleName(node);
			if (!name) return null;
			// A constructor repeats the class name, which is already a tag.
			const parent = node.parent;
			const className = parent?.type === "class_statement" ? powershellSimpleName(parent) : null;
			return name === className ? null : { name, kind: "method" };
		}
		case "class_property_definition": {
			const variable = node.namedChildren.find((child) => child?.type === "variable");
			// The node spells the member `$Name`; the reference side spells it
			// `Name`, so drop the sigil or the two never join.
			const name = variable ? variable.text.replace(/^\$/, "") : null;
			return name ? { name, kind: "method" } : null;
		}
		default:
			return null;
	}
}

function powershellReference(node: SyntaxNode): string | null {
	switch (node.type) {
		case "command":
			return node.childForFieldName("command_name")?.text ?? null;
		// `$obj.Speak()` is an invocation node (the grammar spells it
		// `invokation_expression`), not a command; the member name is the callee.
		case "invokation_expression": {
			const member = node.namedChildren.find((child) => child?.type === "member_name");
			return member ? powershellSimpleName(member) : null;
		}
		default:
			return null;
	}
}

function declarationTable(table: Record<string, RepoMapTagDefinitionKind>): RepoMapTagRules["definition"] {
	return (node) => {
		const kind = table[node.type];
		if (!kind) return null;
		const name = node.childForFieldName("name");
		return name ? { name: name.text, kind } : null;
	};
}

const javascriptRules: RepoMapTagRules = { definition: jsDefinition, reference: jsReference };
const pythonRules: RepoMapTagRules = {
	definition: declarationTable(PYTHON_DECLARATIONS),
	reference: pythonReference,
};
const goRules: RepoMapTagRules = { definition: declarationTable(GO_DECLARATIONS), reference: goReference };
const rustRules: RepoMapTagRules = { definition: declarationTable(RUST_DECLARATIONS), reference: rustReference };
const javaRules: RepoMapTagRules = { definition: declarationTable(JAVA_DECLARATIONS), reference: javaReference };
const csharpRules: RepoMapTagRules = {
	definition: declarationTable(CSHARP_DECLARATIONS),
	reference: csharpReference,
};
const cppRules: RepoMapTagRules = { definition: cppDefinition, reference: cppReference };
const rubyRules: RepoMapTagRules = { definition: rubyDefinition, reference: rubyReference };
const phpRules: RepoMapTagRules = { definition: phpDefinition, reference: phpReference };
const bashRules: RepoMapTagRules = { definition: bashDefinition, reference: bashReference };
const powershellRules: RepoMapTagRules = {
	definition: powershellDefinition,
	reference: powershellReference,
};

export const REPO_MAP_TAG_RULES: Record<RepoMapLanguage, RepoMapTagRules> = {
	typescript: javascriptRules,
	tsx: javascriptRules,
	javascript: javascriptRules,
	python: pythonRules,
	go: goRules,
	rust: rustRules,
	java: javaRules,
	"c-sharp": csharpRules,
	cpp: cppRules,
	ruby: rubyRules,
	php: phpRules,
	bash: bashRules,
	powershell: powershellRules,
};
