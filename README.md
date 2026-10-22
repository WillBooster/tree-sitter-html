# @willbooster/tree-sitter-html

[![npm version](https://img.shields.io/npm/v/@willbooster/tree-sitter-html.svg)](https://www.npmjs.com/package/@willbooster/tree-sitter-html)
[![license](https://img.shields.io/npm/l/@willbooster/tree-sitter-html.svg)](https://www.npmjs.com/package/@willbooster/tree-sitter-html)
[![Test](https://github.com/WillBooster/tree-sitter-html/actions/workflows/test.yml/badge.svg)](https://github.com/WillBooster/tree-sitter-html/actions/workflows/test.yml)
[![Test rust](https://github.com/WillBooster/tree-sitter-html/actions/workflows/test-rust.yml/badge.svg)](https://github.com/WillBooster/tree-sitter-html/actions/workflows/test-rust.yml)
[![semantic-release](https://img.shields.io/badge/%20%20%F0%9F%93%A6%F0%9F%9A%80-semantic--release-e10079.svg)](https://github.com/semantic-release/semantic-release)
[![wbfy](https://img.shields.io/badge/wbfy-20.45.0-1e90ff.svg)](https://github.com/WillBooster/shared/tree/main/packages/wbfy)
[![crates.io](https://img.shields.io/crates/v/willbooster-tree-sitter-html.svg)](https://crates.io/crates/willbooster-tree-sitter-html)

HTML grammar for [tree-sitter](https://github.com/tree-sitter/tree-sitter), forked from
[tree-sitter/tree-sitter-html](https://github.com/tree-sitter/tree-sitter-html). We are grateful
to its authors and contributors. This is not an official release of that project.

This fork is based on upstream's version 0.23.2 grammar and external scanner and generates the parser with the
[WillBooster/tree-sitter](https://github.com/WillBooster/tree-sitter) generator. The parser carries that fork's own ABI
number `0x57420009`, so it loads with the WillBooster runtime, version 13.0.0 or later in the 13.x series
([willbooster-tree-sitter](https://crates.io/crates/willbooster-tree-sitter),
[@willbooster/web-tree-sitter](https://www.npmjs.com/package/@willbooster/web-tree-sitter)); upstream's runtime rejects
it. Input that contains NUL characters can parse to a different tree than with upstream's 0.23.2 parser, because the
lexers that generator emits treat a NUL character as an ordinary character. This grammar also accepts literal `>`
characters and bare `&` in text nodes, which upstream 0.23.2 rejects. A bare `&` becomes its own `text` node beside
surrounding text, while character references remain `entity` nodes. Text nodes include leading, trailing, and whitespace-only content, including whitespace between markup and character references. A DOCTYPE declaration exposes its uninterpreted body as a `doctype_value` child, including legacy PUBLIC or SYSTEM identifiers. Processing instructions use source-preserving
`processing_instruction` nodes and directive highlights. Delimited `xml` and `xml-stylesheet` targets in any ASCII
case, including XML declarations, and malformed targets produce `comment` nodes. Valid targets start with an ASCII
letter or `_` and continue with ASCII letters, digits, `-` or `_`. A valid-target instruction without a closing `>`
reports an error. In HTML-namespace `title` and `textarea`, tags, comments,
and instructions stay `text`, while character references remain `entity` nodes. Content inside `iframe`, `xmp`,
`noembed`, and `noframes` also stays `text` up to the element's own closing tag. `plaintext` retains all remaining
input as `text`, including closing tags. The grammar's scanner requires an HTML tag-name boundary after
`</script` and `</style`, so longer names and overlapping prefixes remain raw text. Closing-name comparisons
fold only ASCII letters, and embedded NUL characters remain part of raw-text content. In the HTML namespace, a trailing
slash on a `script` or `style` opening tag remains part of its `start_tag`; it does not close the element, so subsequent
content remains raw text until the matching end tag. Self-closing foreign-namespace `script` and `style` use ordinary element nodes. Complete foreign
elements retain raw-text nodes and injection ranges, including CDATA delimiters. MathML `annotation-xml` with an `encoding` value of `text/html` or `application/xhtml+xml`
uses HTML parsing for its children. Encoding comparisons ignore ASCII case and decode character references. Script content follows
HTML escaped and double-escaped states, so closing-tag text inside a double escape remains raw text. A script that reaches
EOF while scanning raw content closes implicitly without an error: its `script_element` has no `end_tag` child, and its
remaining content stays available for JavaScript injection. Incomplete closing tags such as `</script` still report
recovery errors. Unterminated style elements still report an error. Void elements close
before following text, entities, complete comments, and processing instructions, which become siblings instead of children.
Scanner serialization stores the open-tag stack from its innermost tag, compressing runs of identical tags, so active
void, script, and style elements retain their identities when deeply nested. When distinct tags exceed the fixed-size
buffer, serialization prioritizes inner tags and outer namespace boundaries, replacing ordinary outer tags with unknown
runs. Custom tag names are retained in full when they fit the remaining buffer. Names that exceed the buffer are
omitted along with older tags. Lost tag identities can still produce recovery errors when those tags close.
Malformed input after a void element can replace its enclosing element with an `ERROR` node during recovery.

Attribute values retain their complete `attribute_value` range and expose recognized named and numeric character
references as `entity` children. Quoted values retain their `quoted_attribute_value` wrapper. Other value content,
including literal ampersands, has no child nodes, so injections targeting `attribute_value` retain it by default. Set `injection.include-children` when the injected language needs the original reference
spellings. Legacy names without a semicolon remain literal before an ASCII letter, digit, or `=`; unknown
names and incomplete numeric prefixes remain literal. Comments are document or element content, and are not accepted
between attributes. Comment-shaped text inside a quoted value remains part of that value.

## Usage

The npm package ships `tree-sitter-html.wasm` for
[@willbooster/web-tree-sitter](https://www.npmjs.com/package/@willbooster/web-tree-sitter) version 13.0.0 or later in the 13.x series, which runs in Node.js, Bun, browsers, and Cloudflare Workers.
In Node.js and Bun, load the grammar from its path:

```js
import { fileURLToPath } from 'node:url';
import { Language, Parser } from '@willbooster/web-tree-sitter';

await Parser.init();
const parser = new Parser();
const wasmPath = fileURLToPath(import.meta.resolve('@willbooster/tree-sitter-html/tree-sitter-html.wasm'));
parser.setLanguage(await Language.load(wasmPath));
const tree = parser.parse('<!DOCTYPE html>\n<p>Hello</p>\n');
```

In browsers, serve both `.wasm` files and load them by URL (the example uses Vite's `?url` imports):

```js
import { Language, Parser } from '@willbooster/web-tree-sitter';
import runtimeUrl from '@willbooster/web-tree-sitter/web-tree-sitter.wasm?url';
import htmlUrl from '@willbooster/tree-sitter-html/tree-sitter-html.wasm?url';

await Parser.init({ locateFile: () => runtimeUrl });
const parser = new Parser();
parser.setLanguage(await Language.load(htmlUrl));
```

Cloudflare Workers do not allow compiling Wasm at run time, so import both `.wasm` files as modules, with or without
Node.js compatibility:

```js
import { Language, Parser } from '@willbooster/web-tree-sitter';
import runtime from '@willbooster/web-tree-sitter/web-tree-sitter.wasm';
import html from '@willbooster/tree-sitter-html/tree-sitter-html.wasm';

await Parser.init({ wasmModule: runtime });
const parser = new Parser();
parser.setLanguage(await Language.load(html));
```

The package also ships `grammar.js`, the queries in `queries/`, and the node types in `src/node-types.json`.

In Rust, depend on the [crate](https://crates.io/crates/willbooster-tree-sitter-html) and on
[willbooster-tree-sitter](https://crates.io/crates/willbooster-tree-sitter), the runtime this package is tested and
fuzzed with:

```toml
[dependencies]
tree-sitter = { package = "willbooster-tree-sitter", version = "13.0.0" }
tree-sitter-html = { package = "willbooster-tree-sitter-html", version = "8" }
```

```rust
let mut parser = tree_sitter::Parser::new();
parser.set_language(&tree_sitter_html::LANGUAGE.into())?;
```

## Development

```sh
mise install
bun install --frozen-lockfile
bun run test/ci-setup # installs Chromium for the browser test
bun run build/ci
bun run test
script/parse-examples
cargo test
```

The scripts and tests generate, build, test, and parse with `script/tree-sitter`, the tree-sitter CLI of the
WillBooster/tree-sitter runtime version locked in `Cargo.lock`, since the generator and the runtime of upstream's CLI are
not the ones this package ships with. Its first run downloads that CLI from the runtime's GitHub Release, or builds it
with `cargo` (whose build runs the CMake that `mise.toml` pins) when the download fails or the release has no binary that runs here. Run other CLI commands through it as
well (e.g. `script/tree-sitter parse file.html`).

`bun run generate` records a fresh generation profile from the applicable `test/corpus` cases and Git-tracked
files in `examples/`, then generates compact parser tables. The parser also embeds metadata from `tree-sitter.json`. After changing a grammar,
`tree-sitter.json`, a corpus case, or a tracked example,
regenerate and commit `src/`. Stage added or removed examples with `git add -A examples` before generation so the profile uses the intended file list.
Profiles in `.tmp/generation-profiles/` are temporary and must not be committed. `bun run build-wasm`, `bun run build/ci`,
and the release build regenerate the parsers before compiling them.

`bun run test` runs:

- the corpus in `test/corpus`, with the native build and with the Wasm build (the first run downloads the WASI SDK);
- an incremental-parsing check (`test/unit/incremental.test.ts`): `script/fuzz-corpus` runs `tree-sitter fuzz`, which
  edits each corpus case at random, reparses it, undoes the edits, and reparses again. `TREE_SITTER_SEED`,
  `TREE_SITTER_ITERATIONS`, and `TREE_SITTER_EDITS` run other or more edits;
- a check that the real-world HTML files in `examples/`, the checked-in ones and those of the cloned repositories, fail
  to parse exactly as listed in `script/known-failures.txt`. The first run clones the repositories. The example repositories are pinned to commits in
  `script/parse-examples`. After a grammar change or a moved pin alters that list, `script/parse-examples` rewrites it;
  review its diff before committing;
- a performance check (`test/unit/performance.test.ts`) that recovering from an error on each line takes linear
  time, since consumers parse files while they are being edited. It loads the Wasm build through
  @willbooster/web-tree-sitter, which `bun run build/ci` rebuilds after regenerating the parser;
- a check (`test/unit/runtimeVersion.test.ts`) that `@willbooster/web-tree-sitter` in `package.json` and
  `willbooster-tree-sitter` in `Cargo.lock` are the same version, since the Wasm tests run on the former and the Rust
  tests, the fuzzer, and the CLI on the latter;
- tests that load the Wasm build with @willbooster/web-tree-sitter in Chromium (`test/e2e/browser.test.ts`) and in
  Cloudflare Workers with and without Node.js compatibility (`test/e2e/workers.test.ts`).

The tests and `script/parse-examples` compile the parser into `.tmp/tree-sitter-lib` rather than the CLI's cache shared
by every checkout; `script/fuzz-corpus` builds a parser of its own in `.tmp/fuzz` for each run and deletes it
afterwards.

CI also runs these tests on Linux arm64 and macOS, where the CLI compiles the parser and the scanner natively, and fuzzes
both with libFuzzer and sanitizers (`.github/workflows/robustness.yml`).

Run `script/generate-entities` with Python 3.8 or later when refreshing the HTML Standard's named-reference data, then regenerate
and commit `src/`. The command reads the official `entities.json` over HTTPS.

### References

- [The HTML Standard](https://html.spec.whatwg.org/multipage/)
