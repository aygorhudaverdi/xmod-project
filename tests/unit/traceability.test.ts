import { describe, it, expect } from "vitest";
import { scan } from "../../tools/traceability";

describe("traceability scanner (tools/traceability.ts)", () => {
  it("links a test to IDs in its own title", () => {
    expect(scan(`test("US-01 loss-free risk", async () => {});`)).toEqual([{ title: "US-01 loss-free risk", ids: ["US-01"], isTest: true }]);
  });

  it("a test inherits IDs from enclosing describe blocks, and only inside them", () => {
    const src = `
      describe("US-03/US-04 rules", () => {
        it("cap applies", () => { if (x) { y(); } });
        test.describe("nested US-06", () => { test("inner", () => {}); });
      });
      it("outside", () => {});`;
    expect(scan(src).map((t) => [t.title, t.ids])).toEqual([
      ["cap applies", ["US-03", "US-04"]],
      ["inner", ["US-03", "US-04", "US-06"]],
      ["outside", []],
    ]);
  });

  it("reads template-literal and it.each titles", () => {
    const src = "for (const c of cases) { test(`US-06 ${c} -> 422`, () => {}); }\n" +
      'it.each([[1, 2], [3, 4]])("US-02 claim of $%i", () => {});';
    expect(scan(src).map((t) => t.ids)).toEqual([["US-06"], ["US-02"]]);
  });

  it("braces inside strings, templates, comments and regex literals do not break describe scoping", () => {
    const src = `
      describe("US-07 scoped", () => {
        it("a", () => { expect(t).toMatch(/bucket\\{le="0\\.2",/); const s = "{{{"; const u = \`x{ \${ {a:1}.a } {\`; /* { */ });
      });
      it("after", () => {});`;
    expect(scan(src).map((t) => [t.title, t.ids])).toEqual([["a", ["US-07"]], ["after", []]]);
  });

  it("test-like text inside strings and comments is not a test (no false coverage)", () => {
    const src = `const fixture = 'test("US-03 fake", () => {})';\n// it("US-04 commented out", () => {});\ntest("real", () => {});`;
    expect(scan(src)).toEqual([{ title: "real", ids: [], isTest: true }]);
  });

  it("ignores IDs that only appear in test bodies", () => {
    expect(scan(`test("plain", () => { expect("US-05").toBe("US-05"); });`)[0].ids).toEqual([]);
  });
});
