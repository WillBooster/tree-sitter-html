import { expect, test } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

import { Edit, Language, Parser, Query } from '@willbooster/web-tree-sitter';

const root = path.join(import.meta.dirname, '../..');
await Parser.init();
const language = await Language.load(path.join(root, 'tree-sitter-html.wasm'));
const querySource = fs.readFileSync(path.join(root, 'queries/injections.scm'), 'utf8');

for (const tag of ['script', 'style']) {
  test(`preserves ${tag} injection content when an end tag is unfinished`, () => {
    const parser = new Parser();
    parser.setLanguage(language);
    const query = new Query(language, querySource);
    try {
      for (const content of [
        'x',
        `x</${tag}`,
        `x</${tag}\v><p>still raw</p>`,
        `x</ſ${tag.slice(1)}><p>still raw</p>`,
      ]) {
        const tree = parser.parse(`<${tag}>${content}`)!;
        try {
          expect(tree.rootNode.hasError).toBe(false);
          expect(tree.rootNode.namedChildren.map((node) => node.type)).toEqual([`${tag}_element`]);
          expect(query.captures(tree.rootNode).map(({ name, node }) => [name, node.text])).toEqual([
            ['injection.content', content],
          ]);
        } finally {
          tree.delete();
        }
      }
      const emptyTree = parser.parse(`<${tag}>`)!;
      try {
        expect(emptyTree.rootNode.hasError).toBe(false);
        expect(emptyTree.rootNode.namedChildren.map((node) => node.type)).toEqual([`${tag}_element`]);
        expect(query.captures(emptyTree.rootNode)).toEqual([]);
      } finally {
        emptyTree.delete();
      }
    } finally {
      query.delete();
      parser.delete();
    }
  });
}

for (const tag of ['script', 'style']) {
  test(`does not inject ${tag} into custom names or markup inside tags`, () => {
    const parser = new Parser();
    parser.setLanguage(language);
    const query = new Query(language, querySource);
    try {
      for (const suffix of ['!x', '<', '\v', '\u00A0']) {
        const name = `${tag}${suffix}`;
        const tree = parser.parse(`<${name}>text</${name}>`)!;
        try {
          expect(tree.rootNode.hasError).toBe(false);
          expect(tree.rootNode.namedChildren.map((node) => node.type)).toEqual(['element']);
          expect(tree.rootNode.firstNamedChild?.firstNamedChild?.firstNamedChild?.text).toBe(name);
          expect(query.captures(tree.rootNode)).toEqual([]);
        } finally {
          tree.delete();
        }
      }
      for (const source of [
        `<${tag}!x>y`,
        `<${tag}</div>a</div>b`,
        `<div =<${tag}><div>`,
        `</${tag}<<${tag}>. <`,
        `<div <${tag}>text</${tag}>`,
        `<div a=<${tag}>text</div>`,
      ]) {
        const tree = parser.parse(source)!;
        try {
          expect(query.captures(tree.rootNode)).toEqual([]);
        } finally {
          tree.delete();
        }
      }
      const control = parser.parse(`<div =<${tag}></div><${tag} data-x="<other>">real`)!;
      try {
        expect(control.rootNode.hasError).toBe(false);
        expect(query.captures(control.rootNode).map(({ node }) => node.text)).toEqual(['real']);
      } finally {
        control.delete();
      }
    } finally {
      query.delete();
      parser.delete();
    }
  });
}

for (const tag of ['script', 'style']) {
  test(`preserves ${tag} injections after non-letter less-than text`, () => {
    const parser = new Parser();
    parser.setLanguage(language);
    const query = new Query(language, querySource);
    try {
      for (const prefix of ['-', '3', ':', 'é']) {
        const tree = parser.parse(`<${prefix}<${tag}>x</${tag}>`)!;
        try {
          expect(query.captures(tree.rootNode).map(({ node }) => node.text)).toEqual(['x']);
        } finally {
          tree.delete();
        }
      }
    } finally {
      query.delete();
      parser.delete();
    }
  });
}

test('preserves enclosing elements around non-letter less-than text', () => {
  const parser = new Parser();
  parser.setLanguage(language);
  try {
    for (const prefix of ['-', '3', ':', 'é']) {
      const tree = parser.parse(`<div>a <${prefix} b</div><p>c</p>`)!;
      try {
        expect(
          tree.rootNode.descendantsOfType('element').map((node) => node.firstNamedChild?.firstNamedChild?.text)
        ).toEqual(['div', 'p']);
      } finally {
        tree.delete();
      }
    }
  } finally {
    parser.delete();
  }
});

test('preserves complete Unicode custom tag names without raw-text injections', () => {
  const parser = new Parser();
  parser.setLanguage(language);
  const query = new Query(language, querySource);
  try {
    for (const name of [
      'scrip\u2054',
      'styl\u2065',
      'xé',
      'x中',
      'x😀',
      'x' + '中'.repeat(85),
      'x' + '😀'.repeat(254),
    ]) {
      const tree = parser.parse(`<${name}>text</${name}><p>after</p>`)!;
      try {
        expect(tree.rootNode.hasError).toBe(false);
        expect(tree.rootNode.namedChildren.map((node) => node.type)).toEqual(['element', 'element']);
        expect(tree.rootNode.firstNamedChild?.lastNamedChild?.firstNamedChild?.text).toBe(name);
        expect(query.captures(tree.rootNode)).toEqual([]);
      } finally {
        tree.delete();
      }
    }
    const mismatched = parser.parse('<xé>text</x\u01E9><p>after</p>')!;
    try {
      expect(mismatched.rootNode.descendantsOfType('erroneous_end_tag_name').map((node) => node.text)).toContain(
        'x\u01E9'
      );
    } finally {
      mismatched.delete();
    }
  } finally {
    query.delete();
    parser.delete();
  }
});

test('restores distinct long custom names and deeply nested short names', () => {
  const parser = new Parser();
  parser.setLanguage(language);
  try {
    const prefix = 'x' + '中'.repeat(100);
    const source = `<${prefix}a>text</${prefix}a><p>after</p>`;
    const tree = parser.parse(source)!;
    try {
      expect(tree.rootNode.hasError).toBe(false);
      expect(tree.rootNode.firstNamedChild?.lastNamedChild?.firstNamedChild?.text).toBe(`${prefix}a`);
      const offset = source.indexOf('text');
      const updated = source.slice(0, offset) + 'more' + source.slice(offset + 4);
      tree.edit(
        new Edit({
          startIndex: offset,
          oldEndIndex: offset + 4,
          newEndIndex: offset + 4,
          startPosition: { row: 0, column: offset },
          oldEndPosition: { row: 0, column: offset + 4 },
          newEndPosition: { row: 0, column: offset + 4 },
        })
      );
      const incremental = parser.parse(updated, tree)!;
      const fresh = parser.parse(updated)!;
      try {
        expect(incremental.rootNode.toString()).toBe(fresh.rootNode.toString());
        expect(incremental.rootNode.text).toBe(updated);
      } finally {
        incremental.delete();
        fresh.delete();
      }
    } finally {
      tree.delete();
    }
    const mismatched = parser.parse(`<${prefix}a>text</${prefix}b><p>after</p>`)!;
    try {
      expect(mismatched.rootNode.descendantsOfType('erroneous_end_tag_name').map((node) => node.text)).toContain(
        `${prefix}b`
      );
      expect(mismatched.rootNode.descendantsOfType('end_tag').map((node) => node.text)).not.toContain(`</${prefix}b>`);
    } finally {
      mismatched.delete();
    }
    const names = Array.from({ length: 80 }, (_, index) => `x-${index}`);
    const nested = parser.parse(
      names.map((name) => `<${name}>`).join('') +
        'text' +
        names
          .toReversed()
          .map((name) => `</${name}>`)
          .join('')
    )!;
    try {
      expect(nested.rootNode.hasError).toBe(false);
      expect(nested.rootNode.descendantsOfType('element')).toHaveLength(names.length);
      expect(nested.rootNode.descendantsOfType('end_tag')).toHaveLength(names.length);
    } finally {
      nested.delete();
    }
  } finally {
    parser.delete();
  }
});

test('retains enclosing elements around non-letter tag openings', () => {
  const parser = new Parser();
  parser.setLanguage(language);
  try {
    for (const source of ['<div><3>x</3></div>', '<div></3></div>', '<div></-></div>', '<div></_></div>']) {
      const tree = parser.parse(source)!;
      try {
        expect(tree.rootNode.descendantsOfType('start_tag').map((node) => node.firstNamedChild?.text)).toContain('div');
        expect(tree.rootNode.hasError).toBe(false);
        expect(tree.rootNode.firstNamedChild?.type).toBe('element');
        expect(tree.rootNode.descendantsOfType('tag_name').map((node) => node.text)).not.toContain('3');
        expect(tree.rootNode.descendantsOfType('comment').map((node) => node.text)).toContain(
          source.match(/<\/[^>]+>/)![0]
        );
      } finally {
        tree.delete();
      }
    }
    const attribute = parser.parse('<div a=</3>>text</div>')!;
    try {
      expect(attribute.rootNode.hasError).toBe(false);
      expect(attribute.rootNode.descendantsOfType('attribute_value').map((node) => node.text)).toEqual(['</3']);
      expect(attribute.rootNode.descendantsOfType('comment')).toHaveLength(0);
    } finally {
      attribute.delete();
    }
  } finally {
    parser.delete();
  }
});
