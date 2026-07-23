import { RealPiAdapter } from "../apps/server/dist/real-adapter.js";

const cwd = process.argv[2] ? new URL(`file://${process.argv[2]}`).pathname : process.cwd();
const promptIndex = process.argv.indexOf("--prompt");
const adapter = new RealPiAdapter();
const info = await adapter.inspectWorkspace(cwd);
console.log(`Pi SDK inspection succeeded: ${info.models.length} authenticated model(s), ${info.sessions.length} native session(s).`);
if (promptIndex >= 0) {
  const text = process.argv[promptIndex + 1];
  if (!text) throw new Error("Pass prompt text after --prompt. This opt-in path may spend model tokens.");
  const session = await adapter.createSession(cwd, "read-only");
  session.subscribe((event) => { if (event.type === "delta" && event.channel === "text") process.stdout.write(event.delta); });
  try { await session.prompt(text); process.stdout.write("\nReal Pi prompt settled.\n"); } finally { session.dispose(); }
} else {
  console.log("No model request was sent. Add --prompt \"Reply with OK\" to explicitly run a paid smoke turn.");
}
