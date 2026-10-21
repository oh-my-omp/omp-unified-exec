import * as fs from "node:fs";
import * as path from "node:path";

// Independent stateful simulator of `tern plugin list/remove/unlink`, answering
// as Tern 0.9.5 does. The plugin directory holds `<id>/` for a copy and
// `<id>.path` for a link; every other plugin listed stays untouched.
const args = process.argv.slice(2);
const env = process.env;
const config = JSON.parse(fs.readFileSync(env.TERN_TEST_OPTIONS, "utf8"));
const root = env.TERN_TEST_ROOT;
const id = "omp-unified-exec";
const copy = path.join(root, id);
const link = path.join(root, id + ".path");
fs.appendFileSync(env.TERN_TEST_LOG, JSON.stringify(args) + "\n");
function reply(value) { process.stdout.write(JSON.stringify(value) + "\n"); }
function fail(message, code = 1) {
  process.stderr.write(message + "\n");
  process.exit(code);
}
function installed() {
  if (config.stuck && fs.existsSync(path.join(root, "removed"))) return true;
  return fs.existsSync(copy) || fs.existsSync(link);
}
if (args[0] !== "plugin") fail("unexpected command", 64);
const operation = args[1];
if (config.failure === operation) fail(config.failureMessage ?? "tern plugin: " + operation + " unavailable", 23);
if (operation === "list" && args.length === 3 && args[2] === "--json") {
  if (config.catalogReply !== undefined) process.stdout.write(config.catalogReply);
  else reply({ plugins: [{ id: "another-plugin" }, ...(installed() ? [{ id }] : [])], problems: [] });
} else if (operation === "remove" && args.length === 4 && args[2] === id && args[3] === "--json") {
  if (fs.existsSync(link)) fail("tern plugin: " + id + " is linked; use unlink");
  if (!fs.existsSync(copy)) fail("tern plugin: no plugin " + id + " in " + root);
  fs.rmSync(copy, { recursive: true });
  fs.writeFileSync(path.join(root, "removed"), "");
  reply({ removed: copy });
} else if (operation === "unlink" && args.length === 4 && args[2] === id && args[3] === "--json") {
  if (!fs.existsSync(link)) fail("tern plugin: " + id + " is not linked");
  fs.rmSync(link);
  fs.writeFileSync(path.join(root, "removed"), "");
  reply({ removed: link });
} else fail("unexpected arguments", 64);
