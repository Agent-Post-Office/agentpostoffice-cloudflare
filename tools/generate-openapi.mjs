// The YAML is the only editable specification. This JSON is a bundled build artifact.
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
const source = new URL("../packages/openapi/spec/openapi.yaml", import.meta.url);
const target = new URL("../packages/worker/src/openapi.generated.json", import.meta.url);
const output = `${JSON.stringify(parse(readFileSync(source, "utf8")), null, 2)}\n`;
if (process.argv.includes("--check")) {
  if (readFileSync(target, "utf8") !== output) {
    throw new Error(`Stale ${fileURLToPath(target)}; run npm run openapi:generate`);
  }
} else {
  writeFileSync(target, output);
}
