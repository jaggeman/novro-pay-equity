"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");

test("GitHub Actions use immutable revisions and no privileged PR trigger", () => {
  const workflowDir = path.join(root, ".github", "workflows");
  for (const name of fs.readdirSync(workflowDir).filter((file) => /\.ya?ml$/.test(file))) {
    const workflow = fs.readFileSync(path.join(workflowDir, name), "utf8");
    assert.doesNotMatch(workflow, /^\s*pull_request_target\s*:/m, `${name} uses pull_request_target`);
    for (const match of workflow.matchAll(/^\s*-?\s*uses:\s*[^@\s]+@([^\s#]+)/gm)) {
      assert.match(match[1], /^[0-9a-f]{40}$/, `${name} contains a mutable action reference`);
    }
  }
});

test("security policy links directly to private vulnerability reporting", () => {
  const policy = fs.readFileSync(path.join(root, "SECURITY.md"), "utf8");
  assert.match(policy, /github\.com\/jaggeman\/novro-pay-equity\/security\/advisories\/new/);
});
