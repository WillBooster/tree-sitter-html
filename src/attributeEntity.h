#ifndef TREE_SITTER_HTML_ATTRIBUTE_ENTITY_H_
#define TREE_SITTER_HTML_ATTRIBUTE_ENTITY_H_

#include "tree_sitter/parser.h"
#include "entities.h"

#include <string.h>

static bool scan_numeric_attribute_entity(TSLexer *lexer);
static bool scan_named_attribute_entity(TSLexer *lexer);
static const HtmlEntityName *find_html_entity(const char *name);
static bool html_entity_digit(int32_t character, bool hexadecimal);

static bool scan_attribute_entity(TSLexer *lexer, TSSymbol symbol) {
    lexer->advance(lexer, false);
    bool matched = lexer->lookahead == '#' ? scan_numeric_attribute_entity(lexer)
                                           : scan_named_attribute_entity(lexer);
    if (!matched) {
        return false;
    }
    if (lexer->lookahead == ';') {
        lexer->advance(lexer, false);
    }
    lexer->mark_end(lexer);
    lexer->result_symbol = symbol;
    return true;
}

static bool scan_numeric_attribute_entity(TSLexer *lexer) {
    lexer->advance(lexer, false);
    bool hexadecimal = lexer->lookahead == 'x' || lexer->lookahead == 'X';
    if (hexadecimal) {
        lexer->advance(lexer, false);
    }
    bool has_digits = false;
    while (html_entity_digit(lexer->lookahead, hexadecimal)) {
        has_digits = true;
        lexer->advance(lexer, false);
    }
    return has_digits;
}

static bool scan_named_attribute_entity(TSLexer *lexer) {
    char name[HTML_ENTITY_NAME_MAX_LENGTH + 1];
    unsigned length = 0;
    while ((lexer->lookahead >= 'a' && lexer->lookahead <= 'z') ||
           (lexer->lookahead >= 'A' && lexer->lookahead <= 'Z') ||
           (lexer->lookahead >= '0' && lexer->lookahead <= '9')) {
        if (length == HTML_ENTITY_NAME_MAX_LENGTH) {
            return false;
        }
        name[length++] = (char)lexer->lookahead;
        lexer->advance(lexer, false);
    }
    name[length] = '\0';
    const HtmlEntityName *match = find_html_entity(name);
    return match && (lexer->lookahead == ';' || (match->legacy && lexer->lookahead != '='));
}

static const HtmlEntityName *find_html_entity(const char *name) {
    unsigned low = 0;
    unsigned high = sizeof(HTML_ENTITY_NAMES) / sizeof(HTML_ENTITY_NAMES[0]);
    while (low < high) {
        unsigned middle = low + (high - low) / 2;
        int order = strcmp(name, HTML_ENTITY_NAMES[middle].name);
        if (order < 0) {
            high = middle;
        } else if (order > 0) {
            low = middle + 1;
        } else {
            return &HTML_ENTITY_NAMES[middle];
        }
    }
    return NULL;
}

static bool html_entity_digit(int32_t character, bool hexadecimal) {
    return (character >= '0' && character <= '9') ||
           (hexadecimal && ((character >= 'a' && character <= 'f') ||
                            (character >= 'A' && character <= 'F')));
}

#endif
