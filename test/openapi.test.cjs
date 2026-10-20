// Every route registered by the server must be documented in OpenAPI, and nothing else.
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { paths } = require("../scripts/gen-openapi.cjs");

describe("openapi coverage", () => {
  it("documents exactly the registered routes", () => {
    const src = fs.readFileSync(path.join(__dirname, "../server/routes.ts"), "utf8");
    const registered = new Set();
    for (const m of src.matchAll(/route\("(GET|POST|PATCH|DELETE)", "([^"]+)"/g)) {
      registered.add(`${m[1].toLowerCase()} ${m[2].replace(/:([a-zA-Z]+)/g, "{$1}")}`);
    }
    const documented = new Set();
    for (const [p, ops] of Object.entries(paths)) for (const method of Object.keys(ops)) documented.add(`${method} ${p}`);
    const missing = [...registered].filter((x) => !documented.has(x));
    const extra = [...documented].filter((x) => !registered.has(x));
    assert.deepEqual({ missing, extra }, { missing: [], extra: [] });
  });
});
