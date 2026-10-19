// Throwaway diag: spawn and end ConPTY sessions repeatedly in one process.
import { ExecSession } from "../src/session.ts";
import { resolveDefaultShell } from "../src/shell.ts";

const mode = process.env.STRESS_MODE ?? "mixed";
const iterations = Number(process.env.STRESS_N ?? "200");
const concurrency = Number(process.env.STRESS_C ?? "4");
const shell = resolveDefaultShell().shell;
let nextId = 1;

async function one(i: number): Promise<void> {
	const kill = mode === "kill" || (mode === "mixed" && i % 2 === 0);
	const cmd = kill ? "echo start; sleep 30" : "echo start; sleep 0.05; echo end";
	const s = ExecSession.spawn(nextId++, { command: [shell, "-c", cmd], cwd: process.cwd(), env: process.env, cols: 80, rows: 24 });
	if (s.failureMessage) throw new Error(s.failureMessage);
	if (kill) {
		await new Promise<void>((r) => setTimeout(r, 100 + (i % 7) * 30));
		s.terminate("SIGKILL");
	}
	await s.outputClosed.closed();
	await s.release();
}

const t0 = Date.now();
let done = 0;
async function worker(w: number): Promise<void> {
	for (let i = w; i < iterations; i += concurrency) {
		await one(i);
		done++;
		if (done % 25 === 0) console.log(`STRESS progress ${done}/${iterations} ${Date.now() - t0}ms`);
	}
}
await Promise.all(Array.from({ length: concurrency }, (_, w) => worker(w)));
console.log(`STRESS done mode=${mode} n=${iterations} ${Date.now() - t0}ms`);
process.exit(0);
