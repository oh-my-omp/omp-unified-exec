/**
 * What one tool call observed of a session's terminal.
 *
 * A running session reports a consuming observation of its screen; a
 * completed session reports the immutable final projection that term://
 * serves. Calls that observed nothing (spawn failure, cancelled wait) carry
 * no output.
 */

import type { TerminalObservation, TerminalProjection } from "./terminal-screen.ts";

/** Running session: what its terminal shows (see terminal-screen.ts). */
export interface ScreenOutput {
	readonly kind: "screen";
	readonly observation: TerminalObservation;
	readonly terminalUrl?: string;
}

/** Completed output comes from the same immutable projection as term://. */
export interface FinalScreenOutput {
	readonly kind: "final-screen";
	readonly projection: TerminalProjection;
	readonly terminalUrl: string;
}

/** Nothing observed (spawn failure, cancelled wait). */
export interface NoOutput {
	readonly kind: "none";
}

export type CollectResult = ScreenOutput | FinalScreenOutput | NoOutput;

export const NO_OUTPUT: NoOutput = { kind: "none" };
