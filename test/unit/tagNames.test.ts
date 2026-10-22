import { expect, test } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { Edit, Language, Parser, Query, type Tree } from '@willbooster/web-tree-sitter';

const root = path.resolve(import.meta.dirname, '../..');
await Parser.init();
const language = await Language.load(path.join(root, 'tree-sitter-html.wasm'));
const highlights = fs.readFileSync(path.join(root, 'queries/highlights.scm'), 'utf8');
const names = ['x-é', 'x-α', 'x-名', 'x-a\u0301', 'emotion-😍', 'x-a_b', 'x-a.b', 'x-·', 'x-\u200D', 'x-\u00A0'];

test('retains complete native tag names and the following paragraph', () => {
  const directory = fs.mkdtempSync(path.join(root, '.tmp/tag-names-'));
  try {
    const file = path.join(directory, 'input.html');
    const source = names.map((name) => `<${name}>body</${name}>`).join('') + '<p>after</p>';
    fs.writeFileSync(file, source);
    const result = spawnSync('script/tree-sitter', ['parse', '--grammar-path', root, '--xml', file], {
      cwd: root,
      timeout: 30_000,
      encoding: 'utf8',
    });
    expect(result.error).toBeUndefined();
    expect(result.status, result.stdout + result.stderr).toBe(0);
    const captured = [...result.stdout.matchAll(/<tag_name\b[^>]*>(.*?)<\/tag_name>/gs)].map((match) => match[1]);
    expect(captured).toEqual([...names.flatMap((name) => [name, name]), 'p', 'p']);
    expect(result.stdout).not.toContain('<attribute');
    expect(result.stdout).toMatch(/<text\b[^>]*>after<\/text>/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

for (const name of [
  ...names,
  'x-<p',
  'x-?a<b',
  'x-=value',
  'x-"value',
  "x-'value",
  'x-&value',
  `x-${'名'.repeat(100)}`,
]) {
  test(`retains ${name} name ranges and highlights while editing and undoing names`, () => {
    const parser = new Parser().setLanguage(language);
    const query = new Query(language, highlights);
    let source = '<x-base>body</x-base><p>after</p>';
    let tree = parser.parse(source)!;
    let previous = 'x-base';
    try {
      for (const next of [name, 'x-base']) {
        for (const closing of [false, true]) {
          const offset = closing ? source.indexOf('</') + 2 : 1;
          tree.edit(
            new Edit({
              startIndex: offset,
              oldEndIndex: offset + previous.length,
              newEndIndex: offset + next.length,
              startPosition: { row: 0, column: offset },
              oldEndPosition: { row: 0, column: offset + previous.length },
              newEndPosition: { row: 0, column: offset + next.length },
            })
          );
          source = source.slice(0, offset) + next + source.slice(offset + previous.length);
          const updated = parser.parse(source, tree)!;
          tree.delete();
          tree = updated;
          const fresh = parser.parse(source)!;
          try {
            expect(tree.rootNode.toString()).toBe(fresh.rootNode.toString());
            expect(highlightRanges(query, tree)).toEqual(highlightRanges(query, fresh));
            expect(
              tree.rootNode.descendantsOfType('element').find((node) => node.text === '<p>after</p>')?.startIndex
            ).toBe(source.lastIndexOf('<p>'));
          } finally {
            fresh.delete();
          }
        }
        expect(tree.rootNode.hasError).toBe(false);
        expect(tree.rootNode.namedChildren.map((node) => node.text)).toEqual([
          `<${next}>body</${next}>`,
          '<p>after</p>',
        ]);
        const starts = [1, source.indexOf('</') + 2, source.lastIndexOf('<p>') + 1, source.lastIndexOf('</p>') + 2];
        expect(
          query
            .captures(tree.rootNode)
            .filter(({ name }) => name === 'tag')
            .map(({ node }) => [node.text, node.startIndex, node.endIndex])
        ).toEqual([next, next, 'p', 'p'].map((value, index) => [value, starts[index], starts[index]! + value.length]));
        previous = next;
      }
    } finally {
      tree.delete();
      query.delete();
      parser.delete();
    }
  });
}

test('folds ASCII name letters without folding Unicode identities or accepting non-ASCII starts', () => {
  const parser = new Parser().setLanguage(language);
  try {
    for (const [source, error] of [
      ['<X-é>body</x-é><p>after</p>', false],
      ['<x-É>body</x-é><p>after</p>', true],
      ...['é', 'ıframe', '1x', '-x', ':x', '_x'].map((name) => [`<${name}>body</${name}><p>after</p>`, true] as const),
    ] as const) {
      const tree = parser.parse(source)!;
      try {
        expect(tree.rootNode.hasError, source).toBe(error);
        expect(tree.rootNode.descendantsOfType('element').some((node) => node.text === '<p>after</p>')).toBe(true);
      } finally {
        tree.delete();
      }
    }
  } finally {
    parser.delete();
  }
});

function highlightRanges(query: Query, tree: Tree): [string, string, number, number][] {
  return query.captures(tree.rootNode).map(({ name, node }) => [name, node.text, node.startIndex, node.endIndex]);
}

test('keeps attached punctuation in mismatched closing names instead of closing the shorter name', () => {
  const parser = new Parser().setLanguage(language);
  try {
    for (const close of ["</div'>", '</div;>', '</div=>', String.raw`</div\>`, '</div\u00A0>']) {
      const source = `<section><div>body${close}<p>after</p></section>`;
      const tree = parser.parse(source)!;
      try {
        expect(tree.rootNode.descendantsOfType('erroneous_end_tag_name').map((node) => node.text)).toContain(
          close.slice(2, -1)
        );
        expect(tree.rootNode.descendantsOfType('end_tag').map((node) => node.text)).not.toContain(close);
        const following = tree.rootNode.descendantsOfType('element').find((node) => node.text === '<p>after</p>');
        expect([following?.startIndex, following?.endIndex]).toEqual([
          source.indexOf('<p>'),
          source.indexOf('</section>'),
        ]);
      } finally {
        tree.delete();
      }
    }
  } finally {
    parser.delete();
  }
});

test('retains foreign names, HTML text modes and raw-text injections across Unicode wrappers', () => {
  const parser = new Parser().setLanguage(language);
  const query = new Query(language, fs.readFileSync(path.join(root, 'queries/injections.scm'), 'utf8'));
  try {
    for (const [prefix, suffix] of [
      ['<x-😍>', '</x-😍>'],
      ['<svg><x-名><foreignObject>', '</foreignObject></x-名></svg>'],
      ['<math><x-a\u0301><mtext>', '</mtext></x-a\u0301></math>'],
    ]) {
      const source = `${prefix}<textarea>a<b>text</textarea><script>const x=1</script>${suffix}<p>after</p>`;
      const tree = parser.parse(source)!;
      try {
        expect(tree.rootNode.hasError, source).toBe(false);
        expect(tree.rootNode.descendantsOfType('text').map((node) => node.text)).toContain('a<b>text');
        expect(query.captures(tree.rootNode).map(({ node }) => node.text)).toEqual(['const x=1']);
        expect(tree.rootNode.lastNamedChild?.text).toBe('<p>after</p>');
      } finally {
        tree.delete();
      }
    }
  } finally {
    query.delete();
    parser.delete();
  }
});
