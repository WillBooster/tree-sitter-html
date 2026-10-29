import fs from 'node:fs';
import path from 'node:path';

import { Language, Parser, Query } from '@willbooster/web-tree-sitter';
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
      '<section><div>x</div ordinary<img src=x<p>after</p></section>',
    ]) {
      const tree = parser.parse(source)!;
      try {
        expect(tree.rootNode.hasError, source).toBe(true);
        const following = tree.rootNode.descendantsOfType('element').find((node) => node.text === '<p>after</p>');
        expect(following?.startIndex, source).toBe(source.indexOf('<p'));
        expect(following?.endIndex, source).toBe(source.indexOf('<p>after</p>') + '<p>after</p>'.length);
      } finally {
        tree.delete();
      }
    }
  } finally {
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
      '</div/ >',
      '</div/foo>',
      '</div/ q>',
      '</div/  \t>',
      '</div / >',
      '</div /foo>',
      '</div foo>',
      '</div class="a">',
      '</div class="<value>">',
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

test('retains real ancestor end tags after a discarded incomplete start tag', () => {
  const parser = new Parser().setLanguage(language);
  try {
    for (const stray of ['<img src=x ', '<b/']) {
      const source = `<section><div>x</div ordinary${stray}<p>after</p></section>`;
      const tree = parser.parse(source)!;
      try {
        expect(tree.rootNode.hasError, source).toBe(true);
        const section = tree.rootNode.firstNamedChild!;
        expect(section.endIndex, source).toBe(source.length);
        expect(section.namedChildren.find((node) => node.type === 'end_tag')?.text, source).toBe('</section>');
        const following = section.descendantsOfType('element').find((node) => node.text === '<p>after</p>');
        expect(following?.startIndex, source).toBe(source.indexOf('<p>'));
        expect(following?.endIndex, source).toBe(source.indexOf('</section>'));
      } finally {
        tree.delete();
      }
    }
  } finally {
    parser.delete();
  }
});

test('keeps less-than signs inside an opening tag name instead of inventing paragraph openers', () => {
  const parser = new Parser().setLanguage(language);
  try {
    for (const close of ['divq', 'divp']) {
      const source = `<div>x</${close}><p<p>after</p></div>`;
      const tree = parser.parse(source)!;
      try {
        const outer = tree.rootNode.firstNamedChild!;
        expect(outer.endIndex, source).toBe(source.length);
        expect(outer.namedChildren.find((node) => node.type === 'end_tag')?.text, source).toBe('</div>');
        expect(
          outer.descendantsOfType('tag_name').map((node) => node.text),
          source
        ).toContain('p<p');
        expect(
          outer.descendantsOfType('start_tag').some((node) => node.text === '<p>'),
          source
        ).toBe(false);
      } finally {
        tree.delete();
      }
    }
  } finally {
    parser.delete();
  }
});

test('retains elements and real closes when malformed attribute content contains a less-than sign', () => {
  const parser = new Parser().setLanguage(language);
  try {
    for (const [tag, attributes] of [
      ['a', ' href=/q?a<b'],
      ['div', ' a=x<b'],
      ['p', ' a<b'],
      ['a', ' href=/q?a<b&amp;c'],
      ['div', ' a=x<<b'],
      ['div', ' a=<b'],
      ['div', ' a= <b'],
      ['div', ' a="x"<b'],
      ['div', " a='x'<b"],
      ['div', ' a=""<b'],
      ['div', '/a<b'],
    ]) {
      const content = `<${tag}${attributes}>body</${tag}>`;
      const source = `<section>${content}<p>after</p></section>`;
      const tree = parser.parse(source)!;
      try {
        expect(tree.rootNode.hasError, source).toBe(true);
        const section = tree.rootNode.firstNamedChild!;
        const children = section.namedChildren.filter((node) => node.type === 'element');
        expect(
          children.map((node) => node.text),
          source
        ).toEqual([content, '<p>after</p>']);
        expect(children[0]?.namedChildren.find((node) => node.type === 'end_tag')?.text, source).toBe(`</${tag}>`);
        expect(section.namedChildren.find((node) => node.type === 'end_tag')?.text, source).toBe('</section>');
        expect([children[1]?.startIndex, children[1]?.endIndex], source).toEqual([
          source.indexOf('<p>after'),
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

test('retains attribute-recovery ownership after a less-than in an unquoted value', () => {
  const parser = new Parser().setLanguage(language);
  const tree = parser.parse('<section><a href=/q?a<b>body</a><p>after</p></section>')!;
  try {
    expect(tree.rootNode.hasError).toBe(true);
    const section = tree.rootNode.firstNamedChild!;
    expect(section.namedChildren.filter((node) => node.type === 'element').map((node) => node.text)).toEqual([
      '<a href=/q?a<b>body</a>',
      '<p>after</p>',
    ]);
    expect(section.namedChildren.find((node) => node.type === 'end_tag')?.text).toBe('</section>');
  } finally {
    tree.delete();
    parser.delete();
  }
});
