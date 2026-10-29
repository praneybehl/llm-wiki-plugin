// Create the Vectorize index named in wrangler.jsonc when it does not exist.
// The Deploy button creates it itself; this keeps `npm run deploy` single-step.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

/** Remove JSONC comments and trailing commas. Text inside strings is kept as is. */
export function stripJsonc(text) {
  let out = "";
  let i = 0;
  let inString = false;
  while (i < text.length) {
    const ch = text[i];
    const next = text[i + 1];
    if (inString) {
      out += ch;
      if (ch === "\\") {
        out += next ?? "";
        i += 2;
        continue;
      }
      if (ch === '"') inString = false;
      i++;
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      i++;
    } else if (ch === "/" && next === "/") {
      while (i < text.length && text[i] !== "\n") i++;
    } else if (ch === "/" && next === "*") {
      const end = text.indexOf("*/", i + 2);
      i = end < 0 ? text.length : end + 2;
    } else {
      out += ch;
      i++;
    }
  }
  // Trailing commas before } or ] (outside strings, which no longer hold comments).
  return out.replace(/,(\s*[}\]])/g, "$1");
}

function main() {
  const raw = readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8");
  const json = JSON.parse(stripJsonc(raw));
  const indexName = json.vectorize?.[0]?.index_name;
  if (!indexName) return;

  const run = (args) => execFileSync("npx", ["wrangler", ...args], { stdio: "pipe", encoding: "utf8" });
  try {
    run(["vectorize", "get", indexName]);
    console.log(`Vectorize index ${indexName} exists.`);
  } catch {
    console.log(`Creating Vectorize index ${indexName} (384 dimensions, cosine).`);
    run(["vectorize", "create", indexName, "--dimensions=384", "--metric=cosine"]);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
