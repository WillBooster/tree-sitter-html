#ifndef TREE_SITTER_HTML_ATTRIBUTE_ENTITY_H_
#define TREE_SITTER_HTML_ATTRIBUTE_ENTITY_H_

#include "tree_sitter/parser.h"
#include "entities.h"

#include <string.h>

static bool scan_numeric_attribute_entity(TSLexer *lexer);
static bool scan_named_attribute_entity(TSLexer *lexer);
static bool find_html_entity(const char *name, unsigned length, bool *legacy);
static int compare_entity_suffix(const char *left, unsigned left_length, const char *right, unsigned right_length);
static bool html_entity_alpha(int32_t character);
static bool html_entity_digit(int32_t character, bool hexadecimal);

static bool scan_attribute_entity(TSLexer *lexer, TSSymbol symbol, TSSymbol ampersand) {
    lexer->advance(lexer, false);
    lexer->mark_end(lexer);
    bool matched = lexer->lookahead == '#' ? scan_numeric_attribute_entity(lexer)
                                           : scan_named_attribute_entity(lexer);
    if (matched && lexer->lookahead == ';') {
        lexer->advance(lexer, false);
    }
    if (matched) {
        lexer->mark_end(lexer);
    }
    lexer->result_symbol = matched ? symbol : ampersand;
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
    if (!html_entity_alpha(lexer->lookahead)) {
        return false;
    }
    char name[HTML_ENTITY_NAME_MAX_LENGTH];
    unsigned length = 0;
    do {
        if (length == HTML_ENTITY_NAME_MAX_LENGTH) {
            return false;
        }
        name[length++] = (char)lexer->lookahead;
        lexer->advance(lexer, false);
    } while (html_entity_alpha(lexer->lookahead) ||
             (lexer->lookahead >= '0' && lexer->lookahead <= '9'));

    bool legacy = false;
    return find_html_entity(name, length, &legacy) &&
           (lexer->lookahead == ';' || (legacy && lexer->lookahead != '='));
}

static bool find_html_entity(const char *name, unsigned length, bool *legacy) {
    unsigned bucket = (unsigned)((uint8_t)name[0] - (uint8_t)'A');
    unsigned low = HTML_ENTITY_FIRST_CHAR_OFFSET[bucket];
    unsigned high = HTML_ENTITY_FIRST_CHAR_OFFSET[bucket + 1];
    const char *suffix = name + 1;
    unsigned suffix_length = length - 1;
    while (low < high) {
        unsigned middle = low + (high - low) / 2;
        unsigned start = HTML_ENTITY_ENTRIES[middle] >> 1;
        unsigned entry_length = (HTML_ENTITY_ENTRIES[middle + 1] >> 1) - start;
        int order = compare_entity_suffix(suffix, suffix_length, HTML_ENTITY_SUFFIXES + start, entry_length);
        if (order < 0) {
            high = middle;
        } else if (order > 0) {
            low = middle + 1;
        } else {
            *legacy = (HTML_ENTITY_ENTRIES[middle] & 1) != 0;
            return true;
        }
    }
    return false;
}

static int compare_entity_suffix(const char *left, unsigned left_length, const char *right, unsigned right_length) {
    unsigned min_length = left_length < right_length ? left_length : right_length;
    int order = min_length > 0 ? memcmp(left, right, min_length) : 0;
    return order != 0 ? order : (int)left_length - (int)right_length;
}

static bool html_entity_alpha(int32_t character) {
    return (character >= 'a' && character <= 'z') || (character >= 'A' && character <= 'Z');
}

static bool html_entity_digit(int32_t character, bool hexadecimal) {
    return (character >= '0' && character <= '9') ||
           (hexadecimal && ((character >= 'a' && character <= 'f') ||
                            (character >= 'A' && character <= 'F')));
}

#endif
