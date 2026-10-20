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
  const input = String.raw`Outside \(x_i\), ``\(literal\)`` and ```\[\alpha\]```

```python
expr = "\(x^2\)"
other = "\[y\]"
```

    code = "\(z\)"
escaped \\(literal\\) and real \(q\)`;
  const expected = String.raw`Outside $x_i$, ``\(literal\)`` and ```\[\alpha\]```

```python
expr = "\(x^2\)"
other = "\[y\]"
```

    code = "\(z\)"
escaped \\(literal\\) and real $q$`;
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
