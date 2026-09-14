import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageJson = JSON.parse(await readFile(path.join(projectRoot, "package.json"), "utf8"));
const userscript = await readFile(path.join(projectRoot, "OmniGPT.user.js"), "utf8");

function metadataValue(key) {
  const match = userscript.match(new RegExp(`^//\\s+@${key}\\s+(.+)$`, "m"));
  return match?.[1]?.trim() || "";
}

const expectedRawUrl = "https://raw.githubusercontent.com/sakur7a/OmniGPT/main/OmniGPT.user.js";
const errors = [];
const version = metadataValue("version");

if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(packageJson.version)) {
  errors.push(`package.json version is not valid semver-like metadata: ${packageJson.version}`);
}
if (version !== packageJson.version) {
  errors.push(`userscript @version (${version || "missing"}) does not match package.json (${packageJson.version})`);
}
if (metadataValue("downloadURL") !== expectedRawUrl) {
  errors.push("@downloadURL must point to the main-branch GitHub Raw userscript");
}
if (metadataValue("updateURL") !== expectedRawUrl) {
  errors.push("@updateURL must point to the main-branch GitHub Raw userscript");
}
if (!metadataValue("namespace").includes("github.com/sakur7a/OmniGPT")) {
  errors.push("@namespace must remain stable for userscript update identity");
}

if (errors.length) {
  console.error("Release metadata validation failed:");
  errors.forEach((error) => console.error(`- ${error}`));
  process.exit(1);
}

console.log(`Release metadata verified for OmniGPT v${packageJson.version}.`);
