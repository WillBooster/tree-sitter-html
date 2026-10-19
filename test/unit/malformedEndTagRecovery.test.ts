import fs from 'node:fs';
import path from 'node:path';
import { Edit, Language, Parser, Query } from '@willbooster/web-tree-sitter';
import { expect, test } from 'vitest';

await Parser.init();
const language = await Language.load(path.join(import.meta.dirname, '../../tree-sitter-html.wasm'));

test('retains following elements while reporting malformed closing tags', () => {
  const parser = new Parser().setLanguage(language);
  try {
    for (const source of [
      '<div>x</div ordinary<p>after</p>',
      '<div>x</div/><p>after</p>',
      '<div>x</div class="a"/><p>after</p>',
      '<div>x</div x/><p>after</p>',
      '<textarea>x</textarea a=b/><p>after</p>',
      '<script>x</script/><p>after</p>',
    ]) {
      const tree = parser.parse(source)!;
      try {
        expect(tree.rootNode.hasError, source).toBe(true);
        const following = tree.rootNode.descendantsOfType('element').find((node) => node.text === '<p>after</p>');
        expect(following?.startIndex, source).toBe(source.indexOf('<p'));
        expect(following?.endIndex, source).toBe(source.length);
      } finally {
        tree.delete();
      }
    }
  } finally {
    parser.delete();
  }
});

test('preserves following element ranges through an incremental malformed-close edit', () => {
  const parser = new Parser().setLanguage(language);
  const source = '<div>x</div><p>after</p>';
  const previous = parser.parse(source)!;
  try {
    const startIndex = source.indexOf('><p');
    const replacement = ' ordinary';
    previous.edit(
      new Edit({
        startIndex,
        oldEndIndex: startIndex + 1,
        newEndIndex: startIndex + replacement.length,
        startPosition: { row: 0, column: startIndex },
        oldEndPosition: { row: 0, column: startIndex + 1 },
        newEndPosition: { row: 0, column: startIndex + replacement.length },
      })
    );
    const updated = source.slice(0, startIndex) + replacement + source.slice(startIndex + 1);
    const incremental = parser.parse(updated, previous)!;
    const fresh = parser.parse(updated)!;
    try {
      expect(incremental.rootNode.hasError).toBe(true);
      expect(incremental.rootNode.toString()).toBe(fresh.rootNode.toString());
      const following = incremental.rootNode.descendantsOfType('element').find((node) => node.text === '<p>after</p>');
      expect(following?.startIndex).toBe(updated.indexOf('<p'));
      expect(following?.endIndex).toBe(updated.length);
    } finally {
      incremental.delete();
      fresh.delete();
    }
  } finally {
    previous.delete();
    parser.delete();
  }
});

test('retains raw-text elements and their content through malformed closes', () => {
  const parser = new Parser().setLanguage(language);
  const injections = new Query(
    language,
    fs.readFileSync(path.join(import.meta.dirname, '../../queries/injections.scm'), 'utf8')
  );
  try {
    for (const tag of ['script', 'style']) {
      for (const close of [
        `</${tag}/>`,
        `</${tag} foo>`,
        `</${tag} foo/>`,
        `</${tag} class="a"/>`,
        `</${tag} ordinary`,
      ]) {
        const source = `<section><${tag}>body & text${close}<p>after</p></section>`;
        const tree = parser.parse(source)!;
        try {
          expect(tree.rootNode.hasError, source).toBe(true);
          const element = tree.rootNode.descendantsOfType(`${tag}_element`)[0];
          expect(
            element?.descendantsOfType('raw_text').map((node) => node.text),
            source
          ).toEqual(['body & text']);
          expect(
            injections
              .captures(tree.rootNode)
              .some(({ name, node }) => name === 'injection.content' && node.text === 'body & text'),
            source
          ).toBe(true);
          const section = tree.rootNode.firstNamedChild!;
          expect(section.namedChildren.find((node) => node.type === 'end_tag')?.text, source).toBe('</section>');
          expect(
            section.namedChildren.filter((node) => node.type === 'element').map((node) => node.text),
            source
          ).toEqual(['<p>after</p>']);
        } finally {
          tree.delete();
        }
      }
    }
  } finally {
    injections.delete();
    parser.delete();
  }
});

test('retains sibling ownership after closing tags with ignored attributes', () => {
  const parser = new Parser().setLanguage(language);
  try {
    for (const close of [
      '</div foo>',
      '</div class="a">',
      '</div class="<value>">',
      "</div'>",
      '</div;>',
      '</div=>',
      String.raw`</div\>`,
      '</div\u00A0>',
    ]) {
      const source = `<section><div>x${close}<p>after</p></section>`;
      const tree = parser.parse(source)!;
      try {
        expect(tree.rootNode.hasError, source).toBe(true);
        const section = tree.rootNode.descendantsOfType('element').find((node) => node.text === source)!;
        const siblings = section.namedChildren.filter((node) => node.type === 'element');
        expect(siblings, source).toHaveLength(2);
        expect(siblings[0]?.text.startsWith('<div>x'), source).toBe(true);
        expect(
          siblings[0]?.namedChildren
            .find((node) => node.type === 'end_tag')
            ?.descendantsOfType('tag_name')
            .map((node) => node.text),
          source
        ).toEqual(['div']);
        expect(siblings[1]?.text, source).toBe('<p>after</p>');
      } finally {
        tree.delete();
      }
    }
  } finally {
    parser.delete();
  }
});

test('requires a closing style tag at EOF after recovering a malformed close', () => {
  const parser = new Parser().setLanguage(language);
  try {
    for (const source of ['<style>body', '<style></style&amp;><p>after</p>']) {
      const tree = parser.parse(source)!;
      try {
        expect(tree.rootNode.hasError, source).toBe(true);
        expect(
          tree.rootNode.descendantsOfType('raw_text').map((node) => node.text),
          source
        ).toEqual([source.slice('<style>'.length)]);
        expect(tree.rootNode.descendantsOfType('element'), source).toHaveLength(0);
      } finally {
        tree.delete();
      }
    }
  } finally {
    parser.delete();
  }
});

test('preserves real ancestor closing tags after an unmatched slash-ended close', () => {
  const parser = new Parser().setLanguage(language);
  try {
    for (const source of ['<div></p/></div>', '<section><div></p/></div><p>after</p></section>']) {
      const tree = parser.parse(source)!;
      try {
        expect(tree.rootNode.hasError, source).toBe(true);
        const outer = tree.rootNode.firstNamedChild!;
        const name = outer.firstNamedChild?.descendantsOfType('tag_name')[0]?.text;
        expect(outer.namedChildren.find((node) => node.type === 'end_tag')?.text, source).toBe(`</${name}>`);
        if (name === 'section') {
          expect(
            outer.namedChildren.filter((node) => node.type === 'element').map((node) => node.text),
            source
          ).toEqual(['<div></p/></div>', '<p>after</p>']);
        }
      } finally {
        tree.delete();
      }
    }
  } finally {
    parser.delete();
  }
});
