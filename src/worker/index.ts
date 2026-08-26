/**
 * Send worker entry point.
 *
 *   npm run worker            process the queue once and exit
 *   npm run worker -- --loop  poll continuously
 *
 * Runs as a separate process from the web app so that stopping delivery is as
 * simple as stopping this process, independently of the site staying up.
 */
import { pool } from "@/db";
import { runSendWorker } from "./send-worker";
import { getSendSwitch } from "@/lib/settings";

const POLL_MS = 15_000;
const loop = process.argv.includes("--loop");

async function tick() {
  const state = await getSendSwitch();
  if (!state.enabled) {
    console.log(`[worker] idle — ${state.reason}`);
    return;
  }
  const result = await runSendWorker();
  if (result.claimed > 0) {
    console.log(
      `[worker] claimed=${result.claimed} sent=${result.sent} refused=${result.refused} failed=${result.failed}`,
    );
  }
}

async function main() {
  if (!loop) {
    await tick();
    await pool.end();
    return;
  }

  console.log(`[worker] polling every ${POLL_MS / 1000}s. Ctrl-C to stop.`);
  let stopping = false;
  process.on("SIGINT", () => { stopping = true; });
  process.on("SIGTERM", () => { stopping = true; });

  while (!stopping) {
    try {
      await tick();
    } catch (err) {
      console.error("[worker] tick failed:", err);
    }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }

  console.log("[worker] shutting down.");
  await pool.end();
}

main().catch((err) => {
  console.error("[worker] fatal:", err);
  process.exitCode = 1;
});
