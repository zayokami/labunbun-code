/**
 * What `/model <ref>` says when the reference names nothing.
 *
 * The message is a function rather than a line inside `switchModel` only so that
 * something can check it: that closure holds seven bindings, is not exported, and
 * until this was lifted out the wording was a claim in a source file rather than
 * a fact the suite held. The behaviour it describes is the gateway rule in
 * `resolveModel` — a bare id no vendor makes resolves to nothing, while the
 * picker a line away lists it as `provider/id` — and the message is what keeps
 * that rule from reading as a bug.
 */
import { describe, expect, test } from "bun:test";
import { unknownModelMessage } from "../src/interactive.ts";

describe("an unknown model reference", () => {
	test("a bare name the gateway sells says where to get it", () => {
		// The case the hint exists for. `gpt-5-codex` is in the `/model` list as
		// `opencode-zen/gpt-5-codex`, and the bare name deliberately resolves to
		// nothing, so without the second sentence the user is told a model is
		// unknown while looking at it.
		expect(unknownModelMessage("gpt-5-codex")).toBe(
			"Unknown model: gpt-5-codex — offered by opencode-zen, opencode-zen-oai; try opencode-zen/gpt-5-codex",
		);
	});

	test("a model on all four names all four and offers the first", () => {
		// Naming one would send the reader off to compare plans by hand, and the
		// whole point of the line is to avoid that.
		expect(unknownModelMessage("grok-4.6")).toBe(
			"Unknown model: grok-4.6 — offered by opencode-zen, opencode-go, opencode-zen-oai, opencode-go-oai; " +
				"try opencode-zen/grok-4.6",
		);
	});

	test("a name nothing sells gets the plain sentence", () => {
		// A hint needs somewhere to send the reader. There is nowhere here, and
		// inventing one — a near-miss id, a "did you mean" — would be a guess
		// about a typo, which is a different feature and a worse failure.
		expect(unknownModelMessage("nope")).toBe("Unknown model: nope");
	});

	test("a typo in a provider name is not redirected to the real one", () => {
		// `opencode-ze` is not a vendor that sells `gpt-5-codex`; it is a misspelt
		// vendor, and the useful answer is about the vendor, not the model.
		expect(unknownModelMessage("opencode-ze/gpt-5-codex")).toBe("Unknown model: opencode-ze/gpt-5-codex");
	});

	test("a bare name that would have worked never gets a hint", () => {
		// Unreachable from `switchModel`, which only asks after a resolution has
		// failed — and that is the point of asserting it here. The gateway sells
		// `claude-opus-5-5` too, so a hint here would tell a user with a working
		// Anthropic reference to go and buy a subscription.
		expect(unknownModelMessage("claude-opus-5-5")).toBe("Unknown model: claude-opus-5-5");
		expect(unknownModelMessage("deepseek-v4-flash")).toBe("Unknown model: deepseek-v4-flash");
	});
});
