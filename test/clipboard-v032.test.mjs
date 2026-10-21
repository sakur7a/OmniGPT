import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import test from "node:test";

const source = await readFile(new URL("../src/clipboard.js", import.meta.url), "utf8");
const context = { console };
runInNewContext(source, context);
const { normalizeMarkdownMath, formatFormula } = context.OmniGPTClipboard;

test("Markdown copy translates inline ChatGPT math delimiters", () => {
  const input = String.raw`The chain is \(5\leq6\leq7\) and \(x_i = 1\).`;
  const expected = String.raw`The chain is $5\leq6\leq7$ and $x_i = 1$.`;
  assert.equal(normalizeMarkdownMath(input), expected);
});

test("display math becomes a standalone Markdown math block", () => {
  const input = String.raw`Before

\[
  \frac{x}{y} = \alpha
\]

After`;
  const expected = String.raw`Before

$$
\frac{x}{y} = \alpha
$$

After`;
  assert.equal(normalizeMarkdownMath(input), expected);
});

test("code fences, inline code, indented code and escaped literal delimiters are preserved", () => {
  const input = [
    String.raw`Outside \(x_i\), ` + ["`", String.raw`\(literal\)`, "`", " and ``", String.raw`\[\alpha\]`, "``"].join(""),
    "",
    "```python",
    String.raw`expr = "\(x^2\)"`,
    String.raw`other = "\[y\]"`,
    "```",
    "",
    String.raw`    code = "\(z\)"`,
    String.raw`escaped \\(literal\\) and real \(q\)`
  ].join("\n");
  const expected = input
    .replace(String.raw`\(x_i\)`, String.raw`$x_i$`)
    .replace(String.raw`\(q\)`, String.raw`$q$`);
  assert.equal(normalizeMarkdownMath(input), expected);
});

test("unbalanced delimiters and text with no formulas remain unchanged", () => {
  for (const input of [String.raw`This is \(\( unbalanced`, "hello world", "Price $5", String.raw`\\(not formula\\)`]) {
    assert.equal(normalizeMarkdownMath(input), input);
  }
});

test("Math-style preference is still explicit for rendered formulas", () => {
  const formula = { tex: String.raw`5\leq6\leq7`, display: false };
  assert.equal(formatFormula(formula, "markdown"), String.raw`$5\leq6\leq7$`);
  assert.equal(formatFormula(formula, "latex"), String.raw`\(5\leq6\leq7\)`);
});

test("repeated normalization preserves math, ordinary text and code", () => {
  const input = String.raw`Text \(5\leq6\leq7\), $y_i$ and ` + "`\\(literal\\)`\n\n" +
    "```python\n" + String.raw`s = "\[code\]"` + "\n```\n\n" + String.raw`\[z_i\]`;
  const once = normalizeMarkdownMath(input);
  assert.equal(normalizeMarkdownMath(once), once);
  assert.match(once, /\$5\\leq6\\leq7\$/);
  assert.ok(once.includes(String.raw`$y_i$`));
  assert.ok(once.includes(String.raw`\[code\]`));
});
