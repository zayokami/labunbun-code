/**
 * Hand-rolled external store consumed via useSyncExternalStore — selector
 * slices keep rerenders scoped without pulling in a state library.
 */
import { useCallback, useSyncExternalStore } from "react";

export interface Store<S> {
	get(): S;
	set(updater: (state: S) => S): void;
	subscribe(listener: () => void): () => void;
}

export function createStore<S>(initial: S): Store<S> {
	let state = initial;
	const listeners = new Set<() => void>();
	return {
		get: () => state,
		set: (updater) => {
			state = updater(state);
			for (const listener of listeners) listener();
		},
		subscribe: (listener) => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
	};
}

export function useStore<S, T>(store: Store<S>, selector: (state: S) => T): T {
	const subscribe = useCallback((listener: () => void) => store.subscribe(listener), [store]);
	const getSnapshot = useCallback(() => selector(store.get()), [store, selector]);
	return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
