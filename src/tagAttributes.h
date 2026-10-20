#ifndef TREE_SITTER_HTML_TAG_ATTRIBUTES_H_
#define TREE_SITTER_HTML_TAG_ATTRIBUTES_H_

#include <stdint.h>
#include <string.h>

static bool tag_attribute_space(char character);
static char tag_attribute_lower(char character);
static bool tag_attribute_name(const char *value, unsigned length, const char *expected);
static bool tag_attribute_encoding(const char *value, unsigned length);
static uint32_t tag_attribute_character(const char *value, unsigned length, unsigned *offset);

typedef struct {
    unsigned name;
    unsigned name_end;
    unsigned value;
    unsigned value_end;
} TagAttribute;

static TagAttribute tag_attribute(const String *suffix, unsigned *offset);
static void tag_attribute_skip_space(const String *suffix, unsigned *offset);
static uint32_t tag_attribute_numeric_character(const char *value, unsigned length, unsigned *offset);
static unsigned tag_attribute_digit(char character);
static bool tag_attribute_value_end(char quote, char character);

static bool tag_attributes_html_encoding(const String *suffix) {
    unsigned offset = 0;
    while (offset < suffix->size) {
        TagAttribute attribute = tag_attribute(suffix, &offset);
        if (tag_attribute_name(suffix->contents + attribute.name, attribute.name_end - attribute.name, "encoding")) {
            return tag_attribute_encoding(suffix->contents + attribute.value, attribute.value_end - attribute.value);
        }
    }
    return false;
}

static bool tag_attributes_self_closing(const String *suffix) {
    unsigned offset = 0;
    while (offset < suffix->size) {
        tag_attribute_skip_space(suffix, &offset);
        if (offset + 1 == suffix->size && suffix->contents[offset] == '/') return true;
        tag_attribute(suffix, &offset);
    }
    return false;
}

static TagAttribute tag_attribute(const String *suffix, unsigned *offset) {
    tag_attribute_skip_space(suffix, offset);
    while (*offset < suffix->size && suffix->contents[*offset] == '/') (*offset)++;
    TagAttribute attribute = {.name = *offset};
    while (*offset < suffix->size && !tag_attribute_space(suffix->contents[*offset]) &&
           suffix->contents[*offset] != '=' && suffix->contents[*offset] != '/') (*offset)++;
    attribute.name_end = *offset;
    tag_attribute_skip_space(suffix, offset);
    if (*offset == suffix->size || suffix->contents[*offset] != '=') return attribute;
    (*offset)++;
    tag_attribute_skip_space(suffix, offset);
    char quote = *offset < suffix->size ? suffix->contents[*offset] : 0;
    if (quote == '\'' || quote == '"') (*offset)++;
    else quote = 0;
    attribute.value = *offset;
    while (*offset < suffix->size && !tag_attribute_value_end(quote, suffix->contents[*offset])) (*offset)++;
    attribute.value_end = *offset;
    if (quote && *offset < suffix->size) (*offset)++;
    return attribute;
}

static bool tag_attribute_value_end(char quote, char character) {
    return quote ? character == quote : tag_attribute_space(character);
}

static void tag_attribute_skip_space(const String *suffix, unsigned *offset) {
    while (*offset < suffix->size && tag_attribute_space(suffix->contents[*offset])) (*offset)++;
}

static bool tag_attribute_space(char character) {
    return character == ' ' || character == '\t' || character == '\n' || character == '\r' || character == '\f';
}

static char tag_attribute_lower(char character) {
    return character >= 'A' && character <= 'Z' ? character + ('a' - 'A') : character;
}

static bool tag_attribute_name(const char *value, unsigned length, const char *expected) {
    if (strlen(expected) != length) return false;
    for (unsigned i = 0; i < length; i++) {
        if (tag_attribute_lower(value[i]) != expected[i]) return false;
    }
    return true;
}

static bool tag_attribute_encoding(const char *value, unsigned length) {
    const char *types[] = {"text/html", "application/xhtml+xml"};
    for (unsigned type = 0; type < 2; type++) {
        unsigned offset = 0;
        unsigned matched = 0;
        while (offset < length && types[type][matched]) {
            uint32_t character = tag_attribute_character(value, length, &offset);
            if (character > 127 || tag_attribute_lower((char)character) != types[type][matched]) break;
            matched++;
        }
        if (offset == length && types[type][matched] == 0) return true;
    }
    return false;
}

static uint32_t tag_attribute_character(const char *value, unsigned length, unsigned *offset) {
    unsigned start = (*offset)++;
    if (value[start] != '&') return (uint8_t)value[start];
    if (*offset < length && value[*offset] == '#') {
        (*offset)++;
        return tag_attribute_numeric_character(value, length, offset);
    }
    const char *names[] = {"sol;", "plus;"};
    for (unsigned i = 0; i < 2; i++) {
        unsigned size = strlen(names[i]);
        if (length - *offset >= size && memcmp(value + *offset, names[i], size) == 0) {
            *offset += size;
            return i == 0 ? '/' : '+';
        }
    }
    return UINT32_MAX;
}

static uint32_t tag_attribute_numeric_character(const char *value, unsigned length, unsigned *offset) {
    bool hexadecimal = *offset < length && (value[*offset] == 'x' || value[*offset] == 'X');
    if (hexadecimal) (*offset)++;
    unsigned digits = *offset;
    unsigned base = hexadecimal ? 16 : 10;
    uint32_t result = 0;
    while (*offset < length) {
        unsigned digit = tag_attribute_digit(value[*offset]);
        if (digit >= base) break;
        if (result < 128) result = result * base + digit;
        (*offset)++;
    }
    if (*offset == digits) return UINT32_MAX;
    if (*offset < length && value[*offset] == ';') (*offset)++;
    return result;
}

static unsigned tag_attribute_digit(char character) {
    character = tag_attribute_lower(character);
    if (character >= '0' && character <= '9') return character - '0';
    if (character >= 'a' && character <= 'f') return character - 'a' + 10;
    return 16;
}

#endif
