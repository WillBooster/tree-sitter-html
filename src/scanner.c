// code-gauge-allow-file fileNcss 557 -- The external scanner state machines form one cohesive module; splitting unrelated routines would only relocate this size.
#include "tag.h"
#include "tree_sitter/parser.h"
#include "attributeEntity.h"
#include "tagAttributes.h"

#include <wctype.h>

enum TokenType {
    START_TAG_NAME,
    SCRIPT_START_TAG_NAME,
    STYLE_START_TAG_NAME,
    END_TAG_NAME,
    ERRONEOUS_END_TAG_NAME,
    SELF_CLOSING_TAG_DELIMITER,
    IMPLICIT_END_TAG,
    RAW_TEXT,
    COMMENT,
    PROCESSING_INSTRUCTION,
    ELEMENT_TEXT,
    UNFINISHED_PROCESSING_INSTRUCTION,
    ATTRIBUTE_ENTITY,
    UNQUOTED_ATTRIBUTE_ENTITY,
    ATTRIBUTE_AMPERSAND,
    UNQUOTED_ATTRIBUTE_FRAGMENT,
    DISCARDED_START_TAG,
    MISSING_START_TAG_END,
    VOID_START_TAG_NAME,
};

typedef enum { NAMESPACE_HTML, NAMESPACE_SVG, NAMESPACE_MATH, NAMESPACE_MATH_ANNOTATION } Namespace;

typedef struct {
    Tag tag;
    uint32_t parent;
    uint32_t previous_distinct;
    Namespace namespace;
    Namespace child_namespace;
} TagFrame;

typedef struct {
    Array(TagFrame) frames;
    uint32_t current;
} Scanner;

static Namespace child_namespace(Namespace current, const Tag *tag);
static Namespace tag_namespace(Namespace current, const Tag *tag);

static bool scan_contiguous_attribute_content(TSLexer *lexer, const bool *valid_symbols);
static bool scan_unquoted_attribute_fragment(TSLexer *lexer);
static bool is_unquoted_attribute_content(int32_t character);
static bool is_attribute_whitespace(int32_t character);
static bool accepts_tag_suffix(TSLexer *lexer, bool closing, String *suffix);

static inline void advance(TSLexer *lexer) { lexer->advance(lexer, false); }

static inline void skip(TSLexer *lexer) { lexer->advance(lexer, true); }

static inline Tag *top_tag(Scanner *scanner) {
    return scanner->current == 0 ? NULL : &scanner->frames.contents[scanner->current - 1].tag;
}

static void push_tag(Scanner *scanner, Tag tag) {
    Namespace parent = scanner->current == 0 ? NAMESPACE_HTML
        : scanner->frames.contents[scanner->current - 1].child_namespace;
    Namespace current = tag_namespace(parent, &tag);
    uint32_t previous_distinct = scanner->current;
    if (previous_distinct && tag_eq(top_tag(scanner), &tag)) {
        previous_distinct = scanner->frames.contents[previous_distinct - 1].previous_distinct;
    }
    TagFrame frame = {tag, scanner->current, previous_distinct, current, child_namespace(current, &tag)};
    array_push(&scanner->frames, frame);
    scanner->current = scanner->frames.size;
}

static void pop_tag(Scanner *scanner) {
    scanner->current = scanner->frames.contents[scanner->current - 1].parent;
}

// The runtime creates a scanner for each full parse and destroys it on reset. Immutable frames keep snapshots
// valid across parse branches without copying or truncating the open tags into the fixed-size serialization buffer.
static unsigned serialize(Scanner *scanner, char *buffer) {
    memcpy(buffer, &scanner->current, sizeof(scanner->current));
    return sizeof(scanner->current);
}

static void deserialize(Scanner *scanner, const char *buffer, unsigned length) {
    scanner->current = 0;
    if (length == sizeof(scanner->current)) {
        memcpy(&scanner->current, buffer, sizeof(scanner->current));
        assert(scanner->current <= scanner->frames.size);
    }
}

static inline int32_t ascii_upper(int32_t character);
static void append_utf8(String *text, uint32_t character);
static bool is_html_whitespace(int32_t character);

static String scan_tag_name(TSLexer *lexer) {
    String tag_name = array_new();
    int32_t first = ascii_upper(lexer->lookahead);
    if (first < 'A' || first > 'Z') return tag_name;
    while (!lexer->eof(lexer) && lexer->lookahead != 0 && !is_html_whitespace(lexer->lookahead) &&
           lexer->lookahead != '/' && lexer->lookahead != '>') {
        append_utf8(&tag_name, ascii_upper(lexer->lookahead));
        advance(lexer);
    }
    return tag_name;
}

static void append_utf8(String *text, uint32_t character) {
    if (character < 0x80) {
        array_push(text, character);
        return;
    }
    unsigned continuation_count = character < 0x800 ? 1 : character < 0x10000 ? 2 : 3;
    uint8_t prefix = continuation_count == 1 ? 0xC0 : continuation_count == 2 ? 0xE0 : 0xF0;
    array_push(text, prefix | (character >> (6 * continuation_count)));
    while (continuation_count) {
        continuation_count--;
        array_push(text, 0x80 | ((character >> (6 * continuation_count)) & 0x3F));
    }
}

static bool scan_comment(TSLexer *lexer) {
    if (lexer->lookahead != '-') {
        return false;
    }
    advance(lexer);
    if (lexer->lookahead != '-') {
        return false;
    }
    advance(lexer);

    unsigned dashes = 0;
    while (lexer->lookahead) {
        switch (lexer->lookahead) {
            case '-':
                ++dashes;
                break;
            case '>':
                if (dashes >= 2) {
                    lexer->result_symbol = COMMENT;
                    advance(lexer);
                    lexer->mark_end(lexer);
                    return true;
                }
            default:
                dashes = 0;
        }
        advance(lexer);
    }
    return false;
}

static inline int32_t ascii_upper(int32_t character) {
    return character >= 'a' && character <= 'z' ? character - 'a' + 'A' : character;
}

static bool is_raw_name_boundary(TSLexer *lexer);
static bool scan_processing_instruction_target(TSLexer *lexer);
typedef enum { ELEMENT_TEXT_NONE, ELEMENT_TEXT_RAW, ELEMENT_TEXT_RCDATA, ELEMENT_TEXT_PLAINTEXT } ElementTextMode;

static ElementTextMode element_text_mode(Scanner *scanner);
static ElementTextMode classify_element_text(const Tag *tag);
static bool in_html_namespace(const Scanner *scanner);

static bool scan_processing_instruction(TSLexer *lexer, const bool *valid_symbols) {
    if (!valid_symbols[PROCESSING_INSTRUCTION]) {
        return false;
    }
    advance(lexer);
    if (lexer->eof(lexer)) {
        return false;
    }
    bool valid = scan_processing_instruction_target(lexer);
    while (!lexer->eof(lexer) && lexer->lookahead != '>') {
        advance(lexer);
    }
    enum TokenType result = valid ? (lexer->eof(lexer) ? UNFINISHED_PROCESSING_INSTRUCTION : PROCESSING_INSTRUCTION) : COMMENT;
    if (!valid_symbols[result]) {
        return false;
    }
    if (!lexer->eof(lexer)) {
        advance(lexer);
    }
    lexer->mark_end(lexer);
    lexer->result_symbol = result;
    return true;
}

static ElementTextMode element_text_mode(Scanner *scanner) {
    const Tag *tag = top_tag(scanner);
    ElementTextMode mode = tag ? classify_element_text(tag) : ELEMENT_TEXT_NONE;
    return mode != ELEMENT_TEXT_NONE && in_html_namespace(scanner) ? mode : ELEMENT_TEXT_NONE;
}

static ElementTextMode classify_element_text(const Tag *tag) {
    if (tag->type == TEXTAREA || tag->type == TITLE) return ELEMENT_TEXT_RCDATA;
    if (tag->type == IFRAME) return ELEMENT_TEXT_RAW;
    if (tag->type != CUSTOM) return ELEMENT_TEXT_NONE;
    static const struct { const char *name; ElementTextMode mode; } tags[] = {
        {"XMP", ELEMENT_TEXT_RAW}, {"NOEMBED", ELEMENT_TEXT_RAW},
        {"NOFRAMES", ELEMENT_TEXT_RAW}, {"PLAINTEXT", ELEMENT_TEXT_PLAINTEXT},
    };
    for (unsigned i = 0; i < sizeof(tags) / sizeof(tags[0]); i++) {
        size_t length = strlen(tags[i].name);
        if (tag->custom_tag_name.size == length && memcmp(tag->custom_tag_name.contents, tags[i].name, length) == 0) {
            return tags[i].mode;
        }
    }
    return ELEMENT_TEXT_NONE;
}

static Namespace active_namespace(const Scanner *scanner, bool children);

static bool in_html_namespace(const Scanner *scanner) {
    return active_namespace(scanner, false) == NAMESPACE_HTML;
}

static Namespace active_namespace(const Scanner *scanner, bool children) {
    if (scanner->current == 0) return NAMESPACE_HTML;
    const TagFrame *frame = &scanner->frames.contents[scanner->current - 1];
    return children ? frame->child_namespace : frame->namespace;
}

static Namespace tag_namespace(Namespace current, const Tag *tag) {
    if (current == NAMESPACE_MATH_ANNOTATION) {
        current = tag->type == SVG ? NAMESPACE_SVG : NAMESPACE_MATH;
    }
    if (current == NAMESPACE_HTML) {
        if (tag->type == SVG) return NAMESPACE_SVG;
        if (tag->type == MATH) return NAMESPACE_MATH;
    }
    return current;
}

static Namespace child_namespace(Namespace current, const Tag *tag) {
    if (current == NAMESPACE_MATH && tag->type == ANNOTATION_XML) {
        return NAMESPACE_MATH_ANNOTATION;
    }
    if (current == NAMESPACE_MATH && tag->type == ANNOTATION_XML_HTML) {
        return NAMESPACE_HTML;
    }
    if (current == NAMESPACE_SVG && tag->type == TITLE) {
        return NAMESPACE_HTML;
    }
    if (tag->type != CUSTOM) {
        return current;
    }
    static const char *svg_points[] = {"FOREIGNOBJECT", "DESC"};
    static const char *math_points[] = {"MI", "MO", "MN", "MS", "MTEXT"};
    const char **points = current == NAMESPACE_SVG ? svg_points : math_points;
    unsigned count = current == NAMESPACE_SVG ? 2 : 5;
    for (unsigned i = 0; i < count; i++) {
        size_t length = strlen(points[i]);
        if (tag->custom_tag_name.size == length && memcmp(tag->custom_tag_name.contents, points[i], length) == 0) {
            return NAMESPACE_HTML;
        }
    }
    return current;
}

static bool scan_processing_instruction_target(TSLexer *lexer) {
    char target[16] = {0};
    unsigned length = 0;
    int32_t first = ascii_upper(lexer->lookahead);
    bool valid = (first >= 'A' && first <= 'Z') || first == '_';
    while (!lexer->eof(lexer) && lexer->lookahead != '>' && lexer->lookahead != '?' &&
           !is_html_whitespace(lexer->lookahead)) {
        int32_t character = ascii_upper(lexer->lookahead);
        valid &= (character >= 'A' && character <= 'Z') ||
                 (character >= '0' && character <= '9') || character == '-' || character == '_';
        if (length < sizeof(target) - 1) {
            target[length++] = (char)character;
        }
        advance(lexer);
    }
    return valid && (lexer->eof(lexer) || (strcmp(target, "XML") != 0 && strcmp(target, "XML-STYLESHEET") != 0));
}

static bool scan_element_end(TSLexer *lexer, const Tag *tag);
static bool scan_raw_name(TSLexer *lexer, const char *name, unsigned length);

static bool scan_element_text(Scanner *scanner, TSLexer *lexer, ElementTextMode mode, bool can_end) {
    const Tag *tag = top_tag(scanner);
    bool consumed = false;
    lexer->mark_end(lexer);
    while (!lexer->eof(lexer) && !(mode == ELEMENT_TEXT_RCDATA && lexer->lookahead == '&')) {
        if (lexer->lookahead == '<' && mode != ELEMENT_TEXT_PLAINTEXT) {
            if (scan_element_end(lexer, tag)) {
                if (!consumed && can_end && !accepts_tag_suffix(lexer, true, NULL)) {
                    pop_tag(scanner);
                    lexer->result_symbol = IMPLICIT_END_TAG;
                    return true;
                }
                break;
            }
        } else {
            advance(lexer);
        }
        consumed = true;
        lexer->mark_end(lexer);
    }
    lexer->result_symbol = ELEMENT_TEXT;
    return consumed;
}

static bool scan_element_end(TSLexer *lexer, const Tag *tag) {
    advance(lexer);
    if (lexer->lookahead != '/') return false;
    advance(lexer);
    const char *name = tag->custom_tag_name.contents;
    unsigned length = tag->custom_tag_name.size;
    if (tag->type != CUSTOM) {
        for (unsigned i = 0; i < sizeof(TAG_TYPES_BY_TAG_NAME) / sizeof(TAG_TYPES_BY_TAG_NAME[0]); i++) {
            const TagMapEntry *entry = &TAG_TYPES_BY_TAG_NAME[i];
            if (entry->tag_type == tag->type) {
                name = entry->tag_name;
                length = strlen(name);
                break;
            }
        }
    }
    return scan_raw_name(lexer, name, length) && (is_raw_name_boundary(lexer) || lexer->eof(lexer));
}

typedef enum { RAW_TEXT_NORMAL, RAW_TEXT_ESCAPED, RAW_TEXT_DOUBLE_ESCAPED } RawTextMode;

static bool scan_raw_less_than(TSLexer *lexer, bool script, RawTextMode *mode);

// code-gauge-allow functionCognitiveComplexity 19 -- The script escape states share one linear scan; extracting branches would only move their state transitions.
static bool scan_raw_text(Scanner *scanner, TSLexer *lexer) {
    if (scanner->current == 0) {
        return false;
    }

    lexer->mark_end(lexer);
    bool script = top_tag(scanner)->type == SCRIPT;
    RawTextMode mode = RAW_TEXT_NORMAL;
    unsigned dashes = 0;

    while (!lexer->eof(lexer)) {
        if (lexer->lookahead == '<') {
            dashes = 0;
            RawTextMode previous_mode = mode;
            if (scan_raw_less_than(lexer, script, &mode)) {
                break;
            }
            if (previous_mode == RAW_TEXT_NORMAL && mode == RAW_TEXT_ESCAPED) {
                dashes = 2;
            }
            lexer->mark_end(lexer);
            continue;
        }
        if (mode != RAW_TEXT_NORMAL && lexer->lookahead == '-') {
            dashes += dashes < 2;
        } else {
            if (lexer->lookahead == '>' && dashes == 2) {
                mode = RAW_TEXT_NORMAL;
            }
            dashes = 0;
        }
        advance(lexer);
        lexer->mark_end(lexer);
    }

    lexer->result_symbol = RAW_TEXT;
    return true;
}

static bool scan_raw_less_than(TSLexer *lexer, bool script, RawTextMode *mode) {
    advance(lexer);
    if (lexer->lookahead == '/') {
        advance(lexer);
        const char *name = script ? "SCRIPT" : "STYLE";
        if (!scan_raw_name(lexer, name, strlen(name)) ||
            !(is_raw_name_boundary(lexer) || lexer->eof(lexer))) {
            return false;
        }
        if (*mode != RAW_TEXT_DOUBLE_ESCAPED) {
            return true;
        }
        *mode = RAW_TEXT_ESCAPED;
        return false;
    }
    if (script && *mode == RAW_TEXT_NORMAL && lexer->lookahead == '!') {
        advance(lexer);
        if (scan_raw_name(lexer, "--", 2)) {
            *mode = RAW_TEXT_ESCAPED;
        }
    } else if (*mode == RAW_TEXT_ESCAPED && scan_raw_name(lexer, "SCRIPT", 6) && is_raw_name_boundary(lexer)) {
        *mode = RAW_TEXT_DOUBLE_ESCAPED;
    }
    return false;
}

static bool scan_raw_name(TSLexer *lexer, const char *name, unsigned length) {
    for (unsigned i = 0; i < length; i++) {
        if (ascii_upper(lexer->lookahead) != name[i]) {
            return false;
        }
        advance(lexer);
    }
    return true;
}

static bool is_raw_name_boundary(TSLexer *lexer) {
    return lexer->lookahead == '>' || lexer->lookahead == '/' || is_html_whitespace(lexer->lookahead);
}

static bool is_html_whitespace(int32_t character) {
    return character == ' ' || character == '\t' || character == '\n' || character == '\r' || character == '\f';
}

static bool scan_foreign_breakout(const Scanner *scanner, TSLexer *lexer, const Tag *tag, bool closing);
static bool tag_starts_foreign_breakout(const Tag *tag, TSLexer *lexer);

// code-gauge-allow functionCognitiveComplexity 26 -- One lookahead decides optional ends, raw-text recovery and foreign-content boundaries; extracting branches only relocates these decisions.
// code-gauge-allow functionNcss 36 -- These decisions share the scanned next tag and its ownership.
static bool scan_implicit_end_tag(Scanner *scanner, TSLexer *lexer) {
    Tag *parent = top_tag(scanner);

    if (parent && parent->type == STYLE && lexer->eof(lexer)) {
        return false;
    }

    bool is_closing_tag = false;
    if (lexer->lookahead == '/') {
        is_closing_tag = true;
        advance(lexer);
    }

    String tag_name = scan_tag_name(lexer);
    if (tag_name.size == 0 && !lexer->eof(lexer)) {
        array_delete(&tag_name);
        return false;
    }

    Tag next_tag = tag_for_name(tag_name);
    if (parent && scan_foreign_breakout(scanner, lexer, &next_tag, is_closing_tag)) {
        pop_tag(scanner);
        lexer->result_symbol = IMPLICIT_END_TAG;
        tag_free(&next_tag);
        return true;
    }

    bool implicit = false;
    if (is_closing_tag) {
        if (parent && tag_eq(parent, &next_tag)) {
            implicit = (parent->type == SCRIPT || parent->type == STYLE) && !accepts_tag_suffix(lexer, true, NULL);
        } else {
            for (uint32_t i = scanner->current; i > 0; i = scanner->frames.contents[i - 1].previous_distinct) {
                if (tag_eq(&scanner->frames.contents[i - 1].tag, &next_tag)) {
                    implicit = true;
                    break;
                }
            }
        }
    } else if (parent) {
        bool document_boundary = (parent->type == HTML || parent->type == HEAD || parent->type == BODY) && lexer->eof(lexer);
        implicit = !tag_can_contain(parent, &next_tag) || document_boundary;
    }
    tag_free(&next_tag);
    if (implicit) {
        pop_tag(scanner);
        lexer->result_symbol = IMPLICIT_END_TAG;
    }
    return implicit;
}

static bool scan_foreign_breakout(const Scanner *scanner, TSLexer *lexer, const Tag *tag, bool closing) {
    if (active_namespace(scanner, true) == NAMESPACE_HTML) return false;
    return closing ? tag->type == BR || tag->type == P : tag_starts_foreign_breakout(tag, lexer);
}

static bool tag_starts_foreign_breakout(const Tag *tag, TSLexer *lexer) {
    static const TagType types[] = {
        B, BLOCKQUOTE, BODY, BR, CODE, DD, DIV, DL, DT, EM, EMBED,
        H1, H2, H3, H4, H5, H6, HEAD, HR, I, IMG, LI, MENU, META,
        OL, P, PRE, RUBY, S, SMALL, SPAN, STRONG, SUB, SUP, TABLE, U, UL, VAR,
    };
    for (unsigned i = 0; i < sizeof(types) / sizeof(types[0]); i++) {
        if (tag->type == types[i]) return true;
    }
    if (tag->type != CUSTOM) return false;
    static const char *names[] = {"BIG", "CENTER", "LISTING", "NOBR", "STRIKE", "TT"};
    for (unsigned i = 0; i < sizeof(names) / sizeof(names[0]); i++) {
        if (tag->custom_tag_name.size == strlen(names[i]) &&
            memcmp(tag->custom_tag_name.contents, names[i], tag->custom_tag_name.size) == 0) return true;
    }
    if (tag->custom_tag_name.size != 4 || memcmp(tag->custom_tag_name.contents, "FONT", 4) != 0) return false;
    String suffix = array_new();
    bool breakout = accepts_tag_suffix(lexer, false, &suffix) && tag_attributes_html_font(&suffix);
    array_delete(&suffix);
    return breakout;
}

static bool scan_start_tag_suffix(TSLexer *lexer, Tag *tag, bool *self_closing);

static bool scan_start_tag_name(Scanner *scanner, TSLexer *lexer) {
    String tag_name = scan_tag_name(lexer);
    if (tag_name.size == 0) {
        array_delete(&tag_name);
        return false;
    }

    lexer->mark_end(lexer);
    Tag tag = tag_for_name(tag_name);
    bool self_closing = false;
    if (!scan_start_tag_suffix(lexer, &tag, &self_closing)) {
        tag_free(&tag);
        lexer->mark_end(lexer);
        lexer->result_symbol = DISCARDED_START_TAG;
        return true;
    }

    push_tag(scanner, tag);
    bool html = in_html_namespace(scanner);
    bool raw = !self_closing || html;
    if (tag_is_void(&tag) && html) {
        lexer->result_symbol = VOID_START_TAG_NAME;
    } else if (raw && tag.type == SCRIPT) {
        lexer->result_symbol = SCRIPT_START_TAG_NAME;
    } else if (raw && tag.type == STYLE) {
        lexer->result_symbol = STYLE_START_TAG_NAME;
    } else {
        lexer->result_symbol = START_TAG_NAME;
    }
    return true;
}

static bool scan_start_tag_suffix(TSLexer *lexer, Tag *tag, bool *self_closing) {
    String suffix = array_new();
    bool annotation = tag->type == ANNOTATION_XML;
    bool raw = tag->type == SCRIPT || tag->type == STYLE;
    bool accepted = accepts_tag_suffix(lexer, false, annotation || raw ? &suffix : NULL);
    if (tag_is_void(tag) && lexer->lookahead == '<') {
        accepted = false;
    }
    *self_closing = raw && tag_attributes_self_closing(&suffix);
    if (accepted && annotation && tag_attributes_html_encoding(&suffix)) {
        tag->type = ANNOTATION_XML_HTML;
    }
    array_delete(&suffix);
    return accepted;
}

static bool scan_end_tag_name(Scanner *scanner, TSLexer *lexer, bool valid_end_tag) {
    String tag_name = scan_tag_name(lexer);

    if (tag_name.size == 0) {
        array_delete(&tag_name);
        return false;
    }

    lexer->mark_end(lexer);
    if (valid_end_tag) {
        if (!accepts_tag_suffix(lexer, true, NULL)) {
            array_delete(&tag_name);
            return false;
        }
    } else {
        while (iswspace(lexer->lookahead)) {
            advance(lexer);
        }
        if (lexer->lookahead != '>') {
            array_delete(&tag_name);
            return false;
        }
    }

    Tag tag = tag_for_name(tag_name);
    if (valid_end_tag && scanner->current > 0 && tag_eq(top_tag(scanner), &tag)) {
        pop_tag(scanner);
        lexer->result_symbol = END_TAG_NAME;
    } else {
        lexer->result_symbol = ERRONEOUS_END_TAG_NAME;
    }

    tag_free(&tag);
    return true;
}

static bool scan_self_closing_tag_delimiter(Scanner *scanner, TSLexer *lexer) {
    advance(lexer);
    if (lexer->lookahead == '>') {
        advance(lexer);
        Tag *tag = top_tag(scanner);
        if (tag) {
            if ((tag->type != SCRIPT && tag->type != STYLE) || !in_html_namespace(scanner)) {
                pop_tag(scanner);
            }
            lexer->result_symbol = SELF_CLOSING_TAG_DELIMITER;
        }
        return true;
    }
    return false;
}

static bool scan_tag_syntax(Scanner *scanner, TSLexer *lexer, const bool *valid_symbols);
static bool scan_markup_open(Scanner *scanner, TSLexer *lexer, const bool *valid_symbols);

static bool accepts_start_tag(const bool *valid_symbols) {
    return valid_symbols[START_TAG_NAME] || valid_symbols[VOID_START_TAG_NAME];
}

static bool scan(Scanner *scanner, TSLexer *lexer, const bool *valid_symbols) {
    if (valid_symbols[IMPLICIT_END_TAG] && !valid_symbols[SELF_CLOSING_TAG_DELIMITER] &&
        top_tag(scanner) && tag_is_void(top_tag(scanner)) && in_html_namespace(scanner)) {
        lexer->mark_end(lexer);
        pop_tag(scanner);
        lexer->result_symbol = IMPLICIT_END_TAG;
        return true;
    }

    if (valid_symbols[IMPLICIT_END_TAG] && lexer->eof(lexer) &&
        top_tag(scanner) && top_tag(scanner)->type == SCRIPT) {
        pop_tag(scanner);
        lexer->result_symbol = IMPLICIT_END_TAG;
        return true;
    }

    bool in_content = !accepts_start_tag(valid_symbols) && !valid_symbols[END_TAG_NAME];
    if (valid_symbols[RAW_TEXT] && in_content) {
        return scan_raw_text(scanner, lexer);
    }

    ElementTextMode mode;
    if (valid_symbols[ELEMENT_TEXT] && in_content && (mode = element_text_mode(scanner)) != ELEMENT_TEXT_NONE) {
        return scan_element_text(scanner, lexer, mode, valid_symbols[IMPLICIT_END_TAG]);
    }

    if (scan_contiguous_attribute_content(lexer, valid_symbols)) {
        return true;
    }

    if (valid_symbols[ATTRIBUTE_ENTITY] && !valid_symbols[UNQUOTED_ATTRIBUTE_ENTITY] && lexer->lookahead == '/') {
        return false;
    }

    return scan_tag_syntax(scanner, lexer, valid_symbols);
}

// code-gauge-allow functionCognitiveComplexity 18 -- Dispatch depends on the lexer state and external token validity; separating cases would only move the branches.
static bool scan_tag_syntax(Scanner *scanner, TSLexer *lexer, const bool *valid_symbols) {
    bool valid_start_tag = accepts_start_tag(valid_symbols);
    bool valid_tag_name = valid_start_tag || valid_symbols[END_TAG_NAME] ||
                          valid_symbols[ERRONEOUS_END_TAG_NAME];
    bool in_tag = valid_tag_name || valid_symbols[SELF_CLOSING_TAG_DELIMITER] ||
                  valid_symbols[UNQUOTED_ATTRIBUTE_ENTITY];
    if (iswspace(lexer->lookahead) && !in_tag) {
        return false;
    }

    while (is_attribute_whitespace(lexer->lookahead)) {
        skip(lexer);
    }
    if (valid_symbols[UNQUOTED_ATTRIBUTE_ENTITY] && !accepts_start_tag(valid_symbols) && lexer->lookahead == '&') {
        return scan_attribute_entity(lexer, UNQUOTED_ATTRIBUTE_ENTITY, ATTRIBUTE_AMPERSAND);
    }

    switch (lexer->lookahead) {
        case '<':
            return scan_markup_open(scanner, lexer, valid_symbols);

        case '\0':
            if (valid_symbols[IMPLICIT_END_TAG]) {
                return scan_implicit_end_tag(scanner, lexer);
            }
            break;

        case '/':
            if (valid_symbols[SELF_CLOSING_TAG_DELIMITER] && !accepts_start_tag(valid_symbols) &&
                !valid_symbols[END_TAG_NAME]) {
                return scan_self_closing_tag_delimiter(scanner, lexer);
            }
            break;

        default:
            if (!valid_tag_name || valid_symbols[RAW_TEXT]) return false;
            return valid_start_tag ? scan_start_tag_name(scanner, lexer)
                                   : scan_end_tag_name(scanner, lexer, valid_symbols[END_TAG_NAME]);
    }

    return false;
}

static bool scan_markup_open(Scanner *scanner, TSLexer *lexer, const bool *valid_symbols) {
    lexer->mark_end(lexer);
    advance(lexer);
    if (valid_symbols[COMMENT] && lexer->lookahead == '!') {
        advance(lexer);
        return scan_comment(lexer);
    }
    if (lexer->lookahead == '?') {
        return scan_processing_instruction(lexer, valid_symbols);
    }
    return valid_symbols[IMPLICIT_END_TAG] && scan_implicit_end_tag(scanner, lexer);
}

static bool scan_contiguous_attribute_content(TSLexer *lexer, const bool *valid_symbols) {
    if (accepts_start_tag(valid_symbols) || lexer->eof(lexer)) {
        return false;
    }
    if (valid_symbols[UNQUOTED_ATTRIBUTE_FRAGMENT] && is_unquoted_attribute_content(lexer->lookahead)) {
        return scan_unquoted_attribute_fragment(lexer);
    }
    return valid_symbols[ATTRIBUTE_ENTITY] && lexer->lookahead == '&' &&
           scan_attribute_entity(lexer, ATTRIBUTE_ENTITY, ATTRIBUTE_AMPERSAND);
}

static bool scan_unquoted_attribute_fragment(TSLexer *lexer) {
    do {
        advance(lexer);
    } while (!lexer->eof(lexer) && is_unquoted_attribute_content(lexer->lookahead));
    lexer->mark_end(lexer);
    lexer->result_symbol = UNQUOTED_ATTRIBUTE_FRAGMENT;
    return true;
}

static bool is_unquoted_attribute_content(int32_t character) {
    return !is_attribute_whitespace(character) &&
           character != '<' && character != '>' && character != '"' && character != '\'' &&
           character != '=' && character != '&';
}

static void advance_tag_suffix(TSLexer *lexer, String *suffix);

// This lookahead consumes input: callers must mark the token end first.
// The implicit-end path inherits that boundary from scan_markup_open.
// code-gauge-allow functionCognitiveComplexity 23 -- Quote, separator and value states share one lookahead scan; extracting transitions would only relocate the state machine.
// code-gauge-allow functionNcss 41 -- The suffix states jointly determine whether later markup belongs to this tag.
static bool accepts_tag_suffix(TSLexer *lexer, bool closing, String *suffix) {
    bool has_attribute_separator = iswspace(lexer->lookahead);
    while (iswspace(lexer->lookahead)) {
        advance_tag_suffix(lexer, suffix);
    }
    if (closing && (lexer->lookahead == '&' || lexer->eof(lexer))) {
        return true;
    }
    int32_t quote = 0;
    int32_t previous = 0;
    bool value_start = false;
    bool attribute_component = false;
    bool unseparated_attribute_syntax = false;
    while (!lexer->eof(lexer)) {
        if (quote) {
            if (lexer->lookahead == quote) {
                quote = 0;
                attribute_component = true;
            }
        } else if (value_start && (lexer->lookahead == '\'' || lexer->lookahead == '"')) {
            quote = lexer->lookahead;
            value_start = false;
        } else if (lexer->lookahead == '>') {
            return !closing || previous != '/';
        } else if (lexer->lookahead == '<') {
            return !closing && (attribute_component || value_start || unseparated_attribute_syntax);
        } else if (lexer->lookahead == '=') {
            value_start = true;
            attribute_component = false;
            unseparated_attribute_syntax = !has_attribute_separator;
        } else if (iswspace(lexer->lookahead)) {
            has_attribute_separator = true;
            attribute_component = false;
        } else {
            attribute_component = has_attribute_separator || attribute_component || value_start ||
                                  (lexer->lookahead != '/' && lexer->lookahead != '&');
            value_start = false;
        }
        previous = lexer->lookahead;
        advance_tag_suffix(lexer, suffix);
    }
    // An unfinished start at EOF cannot discard a later ancestor end.
    return !closing;
}

static void advance_tag_suffix(TSLexer *lexer, String *suffix) {
    if (suffix) append_utf8(suffix, lexer->lookahead);
    advance(lexer);
}

static bool is_attribute_whitespace(int32_t character) {
    return (character >= '\t' && character <= '\r') || character == ' ';
}

void *tree_sitter_html_external_scanner_create() {
    Scanner *scanner = (Scanner *)ts_calloc(1, sizeof(Scanner));
    return scanner;
}

bool tree_sitter_html_external_scanner_scan(void *payload, TSLexer *lexer, const bool *valid_symbols) {
    Scanner *scanner = (Scanner *)payload;
    return scan(scanner, lexer, valid_symbols);
}

unsigned tree_sitter_html_external_scanner_serialize(void *payload, char *buffer) {
    Scanner *scanner = (Scanner *)payload;
    return serialize(scanner, buffer);
}

void tree_sitter_html_external_scanner_deserialize(void *payload, const char *buffer, unsigned length) {
    Scanner *scanner = (Scanner *)payload;
    deserialize(scanner, buffer, length);
}

void tree_sitter_html_external_scanner_destroy(void *payload) {
    Scanner *scanner = (Scanner *)payload;
    for (unsigned i = 0; i < scanner->frames.size; i++) {
        tag_free(&scanner->frames.contents[i].tag);
    }
    array_delete(&scanner->frames);
    ts_free(scanner);
}
