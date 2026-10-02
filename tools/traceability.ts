/**
 * Builds docs/TRACEABILITY.md: user story -> acceptance criteria -> tests, by scanning test titles for "US-xx".
 *
 *   npm run trace            regenerate the matrix
 *   npm run trace -- --check fail (exit 1) if a story has no tests or the committed matrix is stale (CI)
 *
 * A title counts for a story when the test's own title, or any enclosing describe title, contains the ID.
 * "US-03/US-04 rules" counts for both.
 */
import { readFileSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { STORIES } from "../web/stories.js";

type Level = "unit" | "api" | "ui";
interface Found { story: string; level: Level; file: string; title: string }

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const OUT = join(ROOT, "docs", "TRACEABILITY.md");
const ID = /US-\d{2}/g;

const walk = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((d) =>
    d.isDirectory() ? walk(join(dir, d.name)) : /\.(spec|test)\.ts$/.test(d.name) ? [join(dir, d.name)] : []);

/**
 * Finds test/describe calls and their titles with a brace-depth scan, so a test inherits the IDs of the
 * describe blocks it sits in. Titles are string or template literals; `${...}` parts are kept verbatim.
 */
export function scan(source: string): { title: string; ids: string[]; isTest: boolean }[] {
  const call = /\b(describe|test\.describe|test|it)(?:\.(?:each|only|skip|fixme)\s*\(\s*\[[\s\S]*?\]\s*\))?\s*\(\s*(["'`])((?:\\.|(?!\2)[\s\S])*?)\2/g;
  const out: { title: string; ids: string[]; isTest: boolean }[] = [];
  const stack: { depth: number; ids: string[] }[] = [];
  const depthAt = braceDepths(source);
  for (const m of source.matchAll(call)) {
    const depth = depthAt[m.index!];
    if (depth < 0) continue; // the match is inside a string, template text, comment or regex: not a real call
    while (stack.length && stack.at(-1)!.depth > depth) stack.pop();
    const kind = m[1];
    const title = m[3].replace(/\s+/g, " ");
    const own = title.match(ID) ?? [];
    const inherited = stack.flatMap((s) => s.ids);
    const ids = [...new Set([...inherited, ...own])];
    if (kind.endsWith("describe")) stack.push({ depth: depth + 1, ids });
    else out.push({ title, ids, isTest: true });
  }
  return out;
}

/**
 * Code-level `{}` depth at every index, or -1 where the index is inside a string, template text, comment or
 * regex literal (braces there are ignored). `${ ... }` inside templates is code. A regex is assumed where `/` follows an operator or
 * opening punctuation, which is enough for test files.
 */
export function braceDepths(src: string): Int32Array {
  const depthAt = new Int32Array(src.length + 1);
  let depth = 0;
  const tpl: number[] = []; // depth at which each open `${` returns to template text
  let i = 0;
  const set = (to: number) => { while (i < to && i < src.length) depthAt[i++] = -1; };
  const skipQuoted = (q: string) => { let j = i + 1; while (j < src.length && src[j] !== q) j += src[j] === "\\" ? 2 : 1; set(j + 1); };
  const skipTemplate = () => { // from just after ` (or after a closing } of ${}) to the closing ` or the next ${
    let j = i;
    while (j < src.length) {
      if (src[j] === "\\") { j += 2; continue; }
      if (src[j] === "`") { set(j + 1); return; }
      if (src[j] === "$" && src[j + 1] === "{") { set(j + 2); tpl.push(depth); depth++; return; }
      j++;
    }
    set(j);
  };
  const prevSignificant = () => { let j = i - 1; while (j >= 0 && /\s/.test(src[j])) j--; return j < 0 ? "" : src[j]; };
  while (i < src.length) {
    const c = src[i];
    if (c === "/" && src[i + 1] === "/") { const j = src.indexOf("\n", i); set(j < 0 ? src.length : j); }
    else if (c === "/" && src[i + 1] === "*") { const j = src.indexOf("*/", i + 2); set(j < 0 ? src.length : j + 2); }
    else if (c === '"' || c === "'") skipQuoted(c);
    else if (c === "`") { set(i + 1); skipTemplate(); }
    else if (c === "/" && (prevSignificant() === "" || "(,=:[!&|?{};+-*%<>~^".includes(prevSignificant()))) {
      let j = i + 1, inClass = false;
      while (j < src.length && src[j] !== "\n") {
        if (src[j] === "\\") { j += 2; continue; }
        if (src[j] === "[") inClass = true; else if (src[j] === "]") inClass = false;
        else if (src[j] === "/" && !inClass) break;
        j++;
      }
      set(j + 1);
    }
    else if (c === "{") { depthAt[i++] = depth; depth++; }
    else if (c === "}") {
      depth--; depthAt[i++] = depth;
      if (tpl.length && tpl.at(-1) === depth) { tpl.pop(); skipTemplate(); }
    }
    else depthAt[i++] = depth;
  }
  depthAt[src.length] = depth;
  return depthAt;
}

function collect(): Found[] {
  const found: Found[] = [];
  for (const file of walk(join(ROOT, "tests"))) {
    const rel = relative(ROOT, file).split(sep).join("/");
    const level = (rel.split("/")[1] ?? "unit") as Level;
    for (const t of scan(readFileSync(file, "utf8"))) {
      for (const story of t.ids) found.push({ story, level, file: rel, title: t.title });
    }
  }
  return found;
}

function render(found: Found[]): { md: string; uncovered: string[] } {
  const uncovered: string[] = [];
  const lines: string[] = [
    "# Traceability matrix",
    "",
    "<!-- Generated by `npm run trace` (tools/traceability.ts). Do not edit by hand; CI fails if it is stale. -->",
    "",
    "Stories and acceptance criteria come from `web/stories.js` (also shown in the app's *User stories* tab).",
    "Tests are linked by the story ID in their title or in an enclosing `describe`. Parameterised titles keep",
    "their `${...}` placeholders, and each one expands to several test cases at run time.",
    "",
    "## Summary",
    "",
    "| Story | Title | Unit | API | UI | Total |",
    "|---|---|---:|---:|---:|---:|",
  ];
  for (const s of STORIES) {
    const mine = found.filter((f) => f.story === s.id);
    const n = (l: Level) => mine.filter((f) => f.level === l).length;
    if (!mine.length) uncovered.push(s.id);
    lines.push(`| ${s.id} | ${s.title} | ${n("unit")} | ${n("api")} | ${n("ui")} | ${mine.length ? mine.length : "**0, NOT COVERED**"} |`);
  }
  for (const s of STORIES) {
    lines.push("", `## ${s.id}: ${s.title}`, "", `> ${s.story}`, "", "**Acceptance criteria**", "");
    s.ac.forEach((a: string, i: number) => lines.push(`${i + 1}. ${a}`));
    lines.push("", "**Tests**", "");
    const mine = found.filter((f) => f.story === s.id);
    if (!mine.length) lines.push("_None. This story is not covered by any automated test._");
    else {
      lines.push("| Level | File | Test |", "|---|---|---|");
      const order: Level[] = ["unit", "api", "ui"];
      mine.sort((a, b) => order.indexOf(a.level) - order.indexOf(b.level) || a.file.localeCompare(b.file));
      for (const f of mine) lines.push(`| ${f.level} | \`${f.file}\` | ${f.title.replace(/\|/g, "\\|")} |`);
    }
  }
  const unknown = [...new Set(found.map((f) => f.story))].filter((id) => !STORIES.some((s: { id: string }) => s.id === id));
  if (unknown.length) lines.push("", "## Tests referencing unknown story IDs", "", ...unknown.map((u) => `- ${u}`));
  return { md: lines.join("\n") + "\n", uncovered };
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const check = process.argv.includes("--check");
  const { md, uncovered } = render(collect());
  let failed = false;
  if (uncovered.length) {
    console.error(`Stories without any automated test: ${uncovered.join(", ")}`);
    failed = true;
  }
  if (check) {
    const current = existsSync(OUT) ? readFileSync(OUT, "utf8").replace(/\r\n/g, "\n") : "";
    if (current !== md) {
      console.error("docs/TRACEABILITY.md is out of date. Run `npm run trace` and commit the result.");
      failed = true;
    }
  } else {
    writeFileSync(OUT, md);
    console.log(`Wrote ${relative(ROOT, OUT)}`);
  }
  const counts = STORIES.map((s: { id: string }) => s.id).join(", ");
  if (!failed) console.log(`All stories covered (${counts}).`);
  process.exit(failed ? 1 : 0);
}
