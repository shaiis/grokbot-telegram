import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("wrangler deploy config", () => {
  it("keeps dashboard plain-text bindings and does not nest keep_vars in an environment", () => {
    const text = readFileSync("wrangler.toml", "utf8");
    expect(text).toMatch(/^keep_vars = true$/m);
    expect(text).not.toMatch(/^\[env\./m);
    expect(text).toMatch(/new_sqlite_classes = \["ChatSession"\]/);
    expect(text).toMatch(/tag = "v1"/);
  });
});
