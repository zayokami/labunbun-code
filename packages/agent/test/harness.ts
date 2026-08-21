/**
 * Loop test harness: builds an AgentSession over a faux provider script and
 * records every AgentEvent for order-sensitive assertions.
 */

import { FAUX_MODEL, type FauxStep, fauxProvider } from "@labunbun/ai";
import type { AgentEndReason, AgentEvent, AnyTool } from "../src/index.ts";
import { AgentSession } from "../src/index.ts";

export interface HarnessResult {
	session: AgentSession;
	events: AgentEvent[];
	reason: AgentEndReason;
}

export async function runHarness(
	steps: FauxStep[],
	options: {
		tools?: AnyTool[];
		systemPrompt?: string;
		prompt?: string;
		store?: ConstructorParameters<typeof AgentSession>[0]["store"];
		depsOverrides?: Partial<ConstructorParameters<typeof AgentSession>[0]["deps"]>;
		maxTurns?: number;
	} = {},
): Promise<HarnessResult> {
	const faux = fauxProvider(steps);
	const events: AgentEvent[] = [];

	const session = new AgentSession({
		model: FAUX_MODEL,
		systemPrompt: options.systemPrompt ?? "test system prompt",
		tools: options.tools ?? [],
		maxTurns: options.maxTurns,
		store: options.store,
		deps: {
			streamFn: faux.streamFn,
			...options.depsOverrides,
		},
	});
	session.on((event) => {
		events.push(event);
	});

	const reason = await session.prompt(options.prompt ?? "go");
	return { session, events, reason };
}
