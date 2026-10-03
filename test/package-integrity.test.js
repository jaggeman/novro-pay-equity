"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const root = path.join(__dirname, "..");

test("every relative CommonJS dependency is present in src", () => {
  const sourceDir = path.join(root, "src");
  for (const file of fs.readdirSync(sourceDir).filter((name) => name.endsWith(".js"))) {
    const source = fs.readFileSync(path.join(sourceDir, file), "utf8");
    for (const match of source.matchAll(/require\(["'](\.[^"']+)["']\)/g)) {
      const target = path.resolve(sourceDir, path.dirname(file), match[1]);
      const candidates = [target, `${target}.js`, path.join(target, "index.js")];
      assert.ok(candidates.some((candidate) => fs.existsSync(candidate)), `${file} requires missing ${match[1]}`);
    }
  }
});

test("the packed module includes the linked guides and runnable example", () => {
  assert.ok(process.env.npm_execpath, "run the suite through npm test");
  const output = execFileSync(process.execPath, [process.env.npm_execpath, "pack", "--dry-run", "--json"], {
    cwd: root,
    encoding: "utf8"
  });
  const packedPaths = new Set(JSON.parse(output)[0].files.map((file) => file.path));
  for (const requiredPath of [
    "docs/calculations.md",
    "docs/integration-guide.md",
    "docs/legal-assumptions.md",
    "docs/privacy-and-anonymity.md",
    "examples/run.js",
    "examples/synthetic-company.json"
  ]) {
    assert.ok(packedPaths.has(requiredPath), `package is missing ${requiredPath}`);
  }

  const readme = fs.readFileSync(path.join(root, "README.md"), "utf8");
  for (const match of readme.matchAll(/\]\((?!https?:\/\/|#)([^)#]+)(?:#[^)]+)?\)/g)) {
    const linkedPath = match[1].replace(/^\.\//, "");
    assert.ok(packedPaths.has(linkedPath), `README links to unpacked ${linkedPath}`);
  }
});
