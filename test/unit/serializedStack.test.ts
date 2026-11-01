import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { Language, Parser, type Tree } from '@willbooster/web-tree-sitter';
import { expect, test } from 'vitest';

const root = path.resolve(import.meta.dirname, '../..');
await Parser.init();
const language = await Language.load(path.join(root, 'tree-sitter-html.wasm'));

const wrappers = [
  { name: 'repeated custom tags', open: '<xyz>'.repeat(1100), close: '</xyz>'.repeat(1100) },
  {
    name: 'runs of known and custom tags',
    open: `<main>${'<div>'.repeat(300)}${'<xyz>'.repeat(300)}${'<span>'.repeat(300)}<p><p-x>`,
    close: `</p-x></p>${'</span>'.repeat(300)}${'</xyz>'.repeat(300)}${'</div>'.repeat(300)}</main>`,
  },
  {
    name: 'foreign content below a long custom name',
    open: `<svg><x-${'a'.repeat(1100)}><foreignObject>`,
    close: `</foreignObject></x-${'a'.repeat(1100)}></svg>`,
  },
  { name: 'alternating known tags', open: '<b><i>'.repeat(600), close: '</i></b>'.repeat(600) },
];

for (const { name, open, close } of wrappers) {
  const prefix = `${open}<section><custom-a>`;
  const source = `${prefix}<br>text<script>content</script></custom-a></section><br>tail${close}`;
  const edited = source.replace('<br>text', '<br>edited');
  const wrapped = `<xyz>${edited}</xyz>`;

  test(`preserves active tags within ${name} in native parses`, () => {
    const directory = fs.mkdtempSync(path.join(root, '.tmp/serialized-stack-'));
    try {
      const file = path.join(directory, 'input.html');
      for (const [input, text] of [
        [source, 'text'],
        [edited, 'edited'],
        [wrapped, 'edited'],
      ] as const) {
        fs.writeFileSync(file, input);
        const result = spawnSync('script/tree-sitter', ['parse', file, '--xml'], {
          cwd: root,
          timeout: 30_000,
          env: { ...process.env, TREE_SITTER_LIBDIR: path.join(root, '.tmp/tree-sitter-lib') },
          encoding: 'utf8',
          maxBuffer: 64 * 1024 * 1024,
        });
        expect(result.error).toBeUndefined();
        expect(result.status).toBe(0);
        const compact = result.stdout.replaceAll(/<(\w+)\b[^>]*>/g, '<$1>').replaceAll(/\s+/g, '');
        expect(compact).toContain(`<void_element>&lt;<tag_name>br</tag_name>&gt;</void_element><text>${text}</text>`);
        expect(compact).toContain('<raw_text>content</raw_text>');
        expect(compact).toContain(
          '<tag_name>custom-a</tag_name>&gt;</end_tag></element><end_tag>&lt;/<tag_name>section</tag_name>'
        );
        expect(compact).toContain('</void_element><text>tail</text>');
      }
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  }, 120_000);

  test(`preserves active tags within ${name} in Wasm parses`, () => {
    const parser = new Parser();
    parser.setLanguage(language);
    try {
      for (const [input, text] of [
        [source, 'text'],
        [edited, 'edited'],
        [wrapped, 'edited'],
      ] as const) {
        const tree = parser.parse(input)!;
        try {
          checkActiveTags(tree, text);
        } finally {
          tree.delete();
        }
      }
    } finally {
      parser.delete();
    }
  }, 30_000);
}

for (const { name, depth = 1 } of [
  { name: `x-${'a'.repeat(253)}` },
  { name: `x-${'a'.repeat(254)}` },
  { name: `x-${'a'.repeat(898)}` },
  { name: `x-${'a'.repeat(1013)}` },
  { name: `x-${'é'.repeat(128)}` },
  { name: `x-${'a'.repeat(898)}`, depth: 3 },
  { name: `x-${'a'.repeat(1014)}` },
  { name: `x-${'a'.repeat(1098)}` },
  { name: `x-${'a'.repeat(65_536)}` },
]) {
  test(`retains following markup with ${depth} ${Buffer.byteLength(name)}-byte custom names`, () => {
    const parser = new Parser().setLanguage(language);
    try {
      const prefix = `<${name}>`.repeat(depth);
      const suffix = `</${name}>`.repeat(depth);
      for (const content of ['before', 'edited']) {
        const source = `${prefix}${content}${suffix}<p>after</p>`;
        const tree = parser.parse(source)!;
        try {
          const following = tree.rootNode.descendantsOfType('element').find((node) => node.text === '<p>after</p>');
          expect(following?.startIndex).toBe(source.indexOf('<p>'));
          expect(following?.endIndex).toBe(source.length);
          expect(tree.rootNode.hasError).toBe(false);
          expect(tree.rootNode.firstNamedChild?.lastNamedChild?.text).toBe(`</${name}>`);
          expect(tree.rootNode.namedChildren.map((node) => node.text)).toEqual([
            `${prefix}${content}${suffix}`,
            '<p>after</p>',
          ]);
        } finally {
          tree.delete();
        }
      }
    } finally {
      parser.delete();
    }
  });
}

test('retains full long names and matching closes in native parses', () => {
  const directory = fs.mkdtempSync(path.join(root, '.tmp/serialized-stack-'));
  try {
    const file = path.join(directory, 'input.html');
    const names = [1100, 65_536].map((length) => `x-${'a'.repeat(length)}`);
    fs.writeFileSync(file, names.map((name) => `<${name}>body</${name}>`).join('') + '<p>after</p>');
    const result = spawnSync('script/tree-sitter', ['parse', file, '--xml'], {
      cwd: root,
      timeout: 30_000,
      env: { ...process.env, TREE_SITTER_LIBDIR: path.join(root, '.tmp/tree-sitter-lib') },
      encoding: 'utf8',
      maxBuffer: 2 * 1024 * 1024,
    });
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    const captured = [...result.stdout.matchAll(/<tag_name\b[^>]*>(.*?)<\/tag_name>/gs)].map((match) => match[1]);
    expect(captured).toEqual([...names.flatMap((name) => [name, name]), 'p', 'p']);
    expect(result.stdout).not.toContain('<erroneous_end_tag');
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('keeps memory bounded while parsing sequential long custom names', () => {
  const result = spawnSync(
    'node',
    [
      '--input-type=module',
      '-e',
      `
    import assert from 'node:assert/strict';
    import { Language, Parser } from '@willbooster/web-tree-sitter';
    await Parser.init();
    const parser = new Parser().setLanguage(await Language.load('tree-sitter-html.wasm'));
    const name = 'x-' + 'a'.repeat(60_000);
    const source = ('<' + name + '>body</' + name + '>').repeat(200) + '<p>after</p>';
    const tree = parser.parse(source);
    try {
      assert.equal(tree.rootNode.hasError, false);
      assert.equal(tree.rootNode.namedChildren.length, 201);
      for (const element of tree.rootNode.namedChildren.slice(0, -1)) {
        assert.equal(element.lastNamedChild.text, '</' + name + '>');
      }
      assert.equal(tree.rootNode.lastNamedChild.text, '<p>after</p>');
    } finally {
      tree.delete();
      parser.delete();
    }
    process.stdout.write(String(process.resourceUsage().maxRSS));
  `,
    ],
    { cwd: root, encoding: 'utf8', timeout: 30_000 }
  );
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
  expect(Number(result.stdout.trim())).toBeLessThan(512 * 1024);
});

test('closes a distant custom ancestor after thousands of distinct nested tags', () => {
  const parser = new Parser().setLanguage(language);
  const names = Array.from({ length: 2000 }, (_, index) => `x-layer-${index}`);
  const prefix = names.map((name) => `<${name}>`).join('');
  try {
    for (const close of [
      names
        .toReversed()
        .map((name) => `</${name}>`)
        .join(''),
      `</${names[0]}>`,
    ]) {
      const tree = parser.parse(`${prefix}body${close}<p>after</p>`)!;
      try {
        expect(tree.rootNode.firstNamedChild?.lastNamedChild?.text).toBe(`</${names[0]}>`);
        expect(tree.rootNode.lastNamedChild?.text).toBe('<p>after</p>');
        expect(tree.rootNode.descendantsOfType('start_tag').map((node) => node.firstNamedChild?.text)).toEqual([
          ...names,
          'p',
        ]);
      } finally {
        tree.delete();
      }
    }
  } finally {
    parser.delete();
  }
});

function checkActiveTags(tree: Tree, text: string): void {
  expect(tree.rootNode.hasError).toBe(false);
  const names = tree.rootNode.descendantsOfType('tag_name');
  const breaks = names.filter((node) => node.text === 'br').map((node) => node.parent);
  expect(breaks.map((node) => node?.text)).toEqual(['<br>', '<br>']);
  expect(breaks.map((node) => [node?.nextNamedSibling?.type, node?.nextNamedSibling?.text])).toEqual([
    ['text', text],
    ['text', 'tail'],
  ]);
  const custom = names.find((node) => node.text === 'custom-a')?.parent?.parent;
  expect(custom?.lastNamedChild?.text).toBe('</custom-a>');
  expect(custom?.parent?.lastNamedChild?.text).toBe('</section>');
  expect(tree.rootNode.descendantsOfType('raw_text').map((node) => node.text)).toEqual(['content']);
}
