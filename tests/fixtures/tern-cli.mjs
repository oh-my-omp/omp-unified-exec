import * as fs from "node:fs";
import * as path from "node:path";

// Independent CLI simulator: catalog entries come from the registered on-disk bundle.
const args = process.argv.slice(2);
const env = process.env;
const config = JSON.parse(fs.readFileSync(env.TERN_TEST_OPTIONS, "utf8"));
const root = env.TERN_TEST_ROOT;
const id = "omp-unified-exec";
const destination = path.join(root, id);
const registration = path.join(root, id + ".path");
fs.appendFileSync(env.TERN_TEST_LOG, JSON.stringify(args) + "\n");
function reply(value) { process.stdout.write(JSON.stringify(value) + "\n"); }
function fail(message, code = 23) {
  process.stdout.write("owner diagnostic\n");
  process.stderr.write(message + "\n");
  process.exit(code);
}
function version(dir) {
  const manifest = fs.readFileSync(path.join(dir, "plugin.toml"), "utf8");
  return /^\s*version\s*=\s*"([^"]*)"\s*$/m.exec(manifest)[1];
}
function catalog() {
  if (fs.existsSync(env.TERN_TEST_CONFLICT) && config.conflictCatalog !== undefined) return config.conflictCatalog;
  const installed = fs.existsSync(env.TERN_TEST_INSTALLED);
  const override = installed ? config.installedCatalog : config.initialCatalog;
  if (override !== undefined) return override;
  let dir = destination;
  if (fs.existsSync(registration)) dir = fs.readFileSync(registration, "utf8").trim();
  if (!fs.existsSync(dir)) return [];
  return [{ id, version: version(dir), css: fs.readFileSync(path.join(dir, "terminals.css"), "utf8"),
    status: "ready" }];
}
if (args[0] !== "plugin") fail("unexpected command", 64);
const operation = args[1];
if (config.failure === operation) fail(config.installError ?? operation + " unavailable");
if (operation === "dir" && args.length === 3 && args[2] === "--json") {
  if (config.directoryReply !== undefined) process.stdout.write(config.directoryReply);
  else reply({ dir: root });
} else if (operation === "list" && args.length === 3 && args[2] === "--json") {
  if (config.catalogReply !== undefined) process.stdout.write(config.catalogReply);
  else reply({ plugins: catalog() });
} else if (operation === "install" && args.length === 5 && args[3] === "--force" && args[4] === "--json") {
  const target = config.ownerConflict ?? (fs.existsSync(registration) ? fs.readFileSync(registration, "utf8").trim() : undefined);
  if (target !== undefined) {
    fs.writeFileSync(env.TERN_TEST_CONFLICT, "conflict");
    fail("tern plugin: " + id + " is linked (" + target + "); use unlink first");
  }
  const source = args[2];
  if (config.copyFault !== "no-copy") {
    fs.rmSync(destination, { recursive: true, force: true });
    if (config.copyFault === "symlink") fs.symlinkSync(source, destination);
    else {
      fs.cpSync(source, destination, { recursive: true });
      const changedFile = { css: "terminals.css", manifest: "plugin.toml", windowScript: "window.luau" }[config.copyFault];
      if (changedFile) fs.appendFileSync(path.join(destination, changedFile), "\n/* incomplete copy */\n");
      if (config.copyFault === "extra-file") fs.writeFileSync(path.join(destination, "unexpected.txt"), "extra");
      if (config.copyFault === "missing-file") fs.rmSync(path.join(destination, "window.luau"));
    }
  }
  fs.writeFileSync(env.TERN_TEST_INSTALLED, "installed");
  const result = { id, version: version(source), dir: destination };
  switch (config.replyFault) {
    case "malformed": process.stdout.write("not JSON\n"); break;
    case "missing-fields": reply({ ok: true }); break;
    case "wrong-id": reply({ ...result, id: "another-plugin" }); break;
    case "wrong-version": reply({ ...result, version: "wrong-version" }); break;
    case "wrong-dir": reply({ ...result, dir: source }); break;
    case "relative-dir": reply({ ...result, dir: id }); break;
    default: reply(result);
  }
} else if (operation === "unlink" && args.length === 4 && args[2] === id && args[3] === "--json") {
  if (!fs.existsSync(registration)) fail("no linked registration");
  fs.unlinkSync(registration);
  reply({ id });
} else fail("unexpected arguments", 64);
