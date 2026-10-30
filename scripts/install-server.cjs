// Installs the server's dependencies after `npm install` in the project root.
// (Runs npm inside server/ with a clean environment, so it can't loop back into
// the root install the way `npm --prefix server install` does on Windows.)
const { execSync } = require("child_process");
const path = require("path");
if (process.env.WA_BRIDGE_SKIP_SERVER_INSTALL) process.exit(0);
const env = { ...process.env, WA_BRIDGE_SKIP_SERVER_INSTALL: "1" };
for (const k of Object.keys(env)) if (/^npm_config_prefix$/i.test(k) || /^npm_package_/i.test(k) || /^npm_lifecycle_/i.test(k)) delete env[k];
execSync("npm install", { cwd: path.join(__dirname, "..", "server"), stdio: "inherit", env, shell: true });
