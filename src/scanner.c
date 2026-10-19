#include "tag.h"
#include "tree_sitter/parser.h"
#include "attributeEntity.h"

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
    ATTRIBUTE_ENTITY,
    UNQUOTED_ATTRIBUTE_ENTITY,
};

typedef struct {
    Tag tag;
    unsigned count;
} TagRun;

// Consecutive identical open tags share one run, so deep repeated nesting stays cheap to scan, serialize, and restore.
typedef struct {
    Array(TagRun) tags;
} Scanner;

#define MAX(a, b) ((a) > (b) ? (a) : (b))
#define MIN(a, b) ((a) < (b) ? (a) : (b))

static inline void advance(TSLexer *lexer) { lexer->advance(lexer, false); }

static inline void skip(TSLexer *lexer) { lexer->advance(lexer, true); }

static inline Tag *top_tag(Scanner *scanner) {
    return scanner->tags.size == 0 ? NULL : &array_back(&scanner->tags)->tag;
}

static void push_tags(Scanner *scanner, Tag tag, unsigned count) {
    Tag *top = top_tag(scanner);
    if (top && tag_eq(top, &tag)) {
        array_back(&scanner->tags)->count += count;
        tag_free(&tag);
    } else {
        array_push(&scanner->tags, ((TagRun){tag, count}));
    }
}

static void pop_tag(Scanner *scanner) {
    TagRun *top = array_back(&scanner->tags);
    if (--top->count == 0) {
        tag_free(&top->tag);
        scanner->tags.size--;
    }
}

static void clear_tags(Scanner *scanner) {
    for (unsigned i = 0; i < scanner->tags.size; i++) {
        tag_free(&scanner->tags.contents[i].tag);
    }
    array_clear(&scanner->tags);
}

// Follows a serialized tag to repeat it the number of times in the next two bytes; no tag type uses this byte.
#define TAG_RUN_MARKER UINT8_MAX
#define TAG_RUN_SIZE (1 + sizeof(uint16_t))

static inline unsigned serialized_tag_size(const Tag *tag) {
    return tag->type == CUSTOM ? 2 + MIN(tag->custom_tag_name.size, UINT8_MAX) : 1;
}

static unsigned write_tag(const Tag *tag, char *buffer, unsigned size) {
    buffer[size++] = (char)tag->type;
    if (tag->type == CUSTOM) {
        unsigned name_length = MIN(tag->custom_tag_name.size, UINT8_MAX);
        buffer[size++] = (char)name_length;
        memcpy(&buffer[size], tag->custom_tag_name.contents, name_length);
        size += name_length;
    }
    return size;
}

// Writes as many of `count` copies of `tag` as fit and returns how many were written.
static uint16_t write_tag_run(const Tag *tag, uint16_t count, char *buffer, unsigned *size) {
    unsigned tag_size = serialized_tag_size(tag);
    if (*size + tag_size > TREE_SITTER_SERIALIZATION_BUFFER_SIZE) {
        return 0;
    }
    *size = write_tag(tag, buffer, *size);
    // A marker that would take more space than the repeated tags would reduce how many distinct tags fit.
    if (count > 1 && TAG_RUN_SIZE <= tag_size * (count - 1) &&
        *size + TAG_RUN_SIZE <= TREE_SITTER_SERIALIZATION_BUFFER_SIZE) {
        buffer[(*size)++] = (char)TAG_RUN_MARKER;
        memcpy(&buffer[*size], &count, sizeof(count));
        *size += sizeof(count);
        return count;
    }
    uint16_t written = 1;
    for (; written < count && *size + tag_size <= TREE_SITTER_SERIALIZATION_BUFFER_SIZE; written++) {
        *size = write_tag(tag, buffer, *size);
    }
    return written;
}

// Serializes the innermost tags first, which void-element closing and raw-text scanning depend on, so that tags
// that do not fit are the outermost ones, which deserialize as unknown.
static unsigned serialize(Scanner *scanner, char *buffer) {
    unsigned depth = 0;
    for (unsigned i = 0; i < scanner->tags.size; i++) {
        depth += scanner->tags.contents[i].count;
    }
    uint16_t tag_count = MIN(depth, UINT16_MAX);
    uint16_t serialized_tag_count = 0;

    unsigned size = sizeof(serialized_tag_count);
    memcpy(&buffer[size], &tag_count, sizeof(tag_count));
    size += sizeof(tag_count);

    for (unsigned i = scanner->tags.size; i > 0 && serialized_tag_count < tag_count; i--) {
        const TagRun *run = &scanner->tags.contents[i - 1];
        uint16_t count = MIN(run->count, (unsigned)(tag_count - serialized_tag_count));
        uint16_t written = write_tag_run(&run->tag, count, buffer, &size);
        serialized_tag_count += written;
        if (written < count) {
            break;
        }
    }

    memcpy(&buffer[0], &serialized_tag_count, sizeof(serialized_tag_count));
    return size;
}

static Tag read_tag(const char *buffer, unsigned *size) {
    Tag tag = tag_new();
    tag.type = (TagType)buffer[(*size)++];
    if (tag.type == CUSTOM) {
        uint8_t name_length = (uint8_t)buffer[(*size)++];
        array_extend(&tag.custom_tag_name, name_length, &buffer[*size]);
        *size += name_length;
    }
    return tag;
}

static void reverse_tag_runs(Scanner *scanner, unsigned begin) {
    for (unsigned end = scanner->tags.size; begin + 1 < end; begin++, end--) {
        TagRun run = scanner->tags.contents[begin];
        scanner->tags.contents[begin] = scanner->tags.contents[end - 1];
        scanner->tags.contents[end - 1] = run;
    }
}

static void deserialize(Scanner *scanner, const char *buffer, unsigned length) {
    clear_tags(scanner);
    if (length == 0) {
        return;
    }

    unsigned size = 0;
    uint16_t serialized_tag_count = 0;
    uint16_t tag_count = 0;
    memcpy(&serialized_tag_count, &buffer[size], sizeof(serialized_tag_count));
    size += sizeof(serialized_tag_count);
    memcpy(&tag_count, &buffer[size], sizeof(tag_count));
    size += sizeof(tag_count);

    if (tag_count > serialized_tag_count) {
        push_tags(scanner, tag_new(), tag_count - serialized_tag_count);
    }

    // Serialized tags start from the innermost one, so their runs are pushed in reverse and then put in order.
    unsigned first_restored_run = scanner->tags.size;
    unsigned restored_tag_count = 0;
    while (restored_tag_count < serialized_tag_count) {
        Tag tag = read_tag(buffer, &size);
        uint16_t count = 1;
        if (size < length && (uint8_t)buffer[size] == TAG_RUN_MARKER) {
            memcpy(&count, &buffer[size + 1], sizeof(count));
            size += TAG_RUN_SIZE;
        }
        restored_tag_count += count;
        push_tags(scanner, tag, count);
    }
    reverse_tag_runs(scanner, first_restored_run);
}

static String scan_tag_name(TSLexer *lexer) {
    String tag_name = array_new();
    while (iswalnum(lexer->lookahead) || lexer->lookahead == '-' || lexer->lookahead == ':') {
        array_push(&tag_name, towupper(lexer->lookahead));
        advance(lexer);
    }
    return tag_name;
}

static bool scan_comment(TSLexer *lexer, bool mark_end) {
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
                    if (mark_end) {
                        lexer->mark_end(lexer);
                    }
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

typedef enum { RAW_TEXT_NORMAL, RAW_TEXT_ESCAPED, RAW_TEXT_DOUBLE_ESCAPED } RawTextMode;

static bool scan_raw_less_than(TSLexer *lexer, bool script, RawTextMode *mode);
static bool scan_raw_name(TSLexer *lexer, const char *name);
static bool is_raw_name_boundary(TSLexer *lexer);

static bool scan_raw_text(Scanner *scanner, TSLexer *lexer) {
    if (scanner->tags.size == 0) {
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
        if (!scan_raw_name(lexer, script ? "SCRIPT" : "STYLE") ||
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
        if (scan_raw_name(lexer, "--")) {
            *mode = RAW_TEXT_ESCAPED;
        }
    } else if (*mode == RAW_TEXT_ESCAPED && scan_raw_name(lexer, "SCRIPT") && is_raw_name_boundary(lexer)) {
        *mode = RAW_TEXT_DOUBLE_ESCAPED;
    }
    return false;
}

static bool scan_raw_name(TSLexer *lexer, const char *name) {
    for (unsigned i = 0; name[i]; i++) {
        if (ascii_upper(lexer->lookahead) != name[i]) {
            return false;
        }
        advance(lexer);
    }
    return true;
}

static bool is_raw_name_boundary(TSLexer *lexer) {
    return lexer->lookahead == '>' || lexer->lookahead == '/' || lexer->lookahead == ' ' ||
           lexer->lookahead == '\t' || lexer->lookahead == '\n' || lexer->lookahead == '\r' ||
           lexer->lookahead == '\f';
}

static bool scan_implicit_end_tag(Scanner *scanner, TSLexer *lexer) {
    Tag *parent = top_tag(scanner);

    bool is_closing_tag = false;
    if (lexer->lookahead == '/') {
        is_closing_tag = true;
        advance(lexer);
    } else {
        if (parent && tag_is_void(parent)) {
            pop_tag(scanner);
            lexer->result_symbol = IMPLICIT_END_TAG;
            return true;
        }
    }

    String tag_name = scan_tag_name(lexer);
    if (tag_name.size == 0 && !lexer->eof(lexer)) {
        array_delete(&tag_name);
        return false;
    }

    Tag next_tag = tag_for_name(tag_name);

    if (is_closing_tag) {
        if (parent && tag_eq(parent, &next_tag)) {
            tag_free(&next_tag);
            return false;
        }

        for (unsigned i = scanner->tags.size; i > 0; i--) {
            if (scanner->tags.contents[i - 1].tag.type == next_tag.type) {
                pop_tag(scanner);
                lexer->result_symbol = IMPLICIT_END_TAG;
                tag_free(&next_tag);
                return true;
            }
        }
    } else if (
        parent &&
        (
            !tag_can_contain(parent, &next_tag) ||
            ((parent->type == HTML || parent->type == HEAD || parent->type == BODY) && lexer->eof(lexer))
        )
    ) {
        pop_tag(scanner);
        lexer->result_symbol = IMPLICIT_END_TAG;
        tag_free(&next_tag);
        return true;
    }

    tag_free(&next_tag);
    return false;
}

static bool scan_start_tag_name(Scanner *scanner, TSLexer *lexer) {
    String tag_name = scan_tag_name(lexer);
    if (tag_name.size == 0) {
        array_delete(&tag_name);
        return false;
    }

    Tag tag = tag_for_name(tag_name);
    push_tags(scanner, tag, 1);
    switch (tag.type) {
        case SCRIPT:
            lexer->result_symbol = SCRIPT_START_TAG_NAME;
            break;
        case STYLE:
            lexer->result_symbol = STYLE_START_TAG_NAME;
            break;
        default:
            lexer->result_symbol = START_TAG_NAME;
            break;
    }
    return true;
}

static bool scan_end_tag_name(Scanner *scanner, TSLexer *lexer, bool valid_end_tag) {
    String tag_name = scan_tag_name(lexer);

    if (tag_name.size == 0) {
        array_delete(&tag_name);
        return false;
    }

    if (!valid_end_tag) {
        lexer->mark_end(lexer);
        while (iswspace(lexer->lookahead)) {
            advance(lexer);
        }
        if (lexer->lookahead != '>') {
            array_delete(&tag_name);
            return false;
        }
    }

    Tag tag = tag_for_name(tag_name);
    if (valid_end_tag && scanner->tags.size > 0 && tag_eq(top_tag(scanner), &tag)) {
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
        if (scanner->tags.size > 0) {
            pop_tag(scanner);
            lexer->result_symbol = SELF_CLOSING_TAG_DELIMITER;
        }
        return true;
    }
    return false;
}

static bool scan_comment_or_void_end(Scanner *scanner, TSLexer *lexer, bool close_void) {
    advance(lexer);
    if (!scan_comment(lexer, !close_void)) {
        return false;
    }
    if (close_void) {
        pop_tag(scanner);
        lexer->result_symbol = IMPLICIT_END_TAG;
    }
    return true;
}

static bool scan_markup_open(Scanner *scanner, TSLexer *lexer, const bool *valid_symbols, bool close_void) {
    lexer->mark_end(lexer);
    advance(lexer);
    if (valid_symbols[COMMENT] && lexer->lookahead == '!') {
        return scan_comment_or_void_end(scanner, lexer, close_void);
    }
    if (close_void && lexer->lookahead != '/') {
        pop_tag(scanner);
        lexer->result_symbol = IMPLICIT_END_TAG;
        return true;
    }
    return valid_symbols[IMPLICIT_END_TAG] && scan_implicit_end_tag(scanner, lexer);
}

static bool scan(Scanner *scanner, TSLexer *lexer, const bool *valid_symbols) {
    if (valid_symbols[IMPLICIT_END_TAG] && lexer->eof(lexer) &&
        top_tag(scanner) && top_tag(scanner)->type == SCRIPT) {
        pop_tag(scanner);
        lexer->result_symbol = IMPLICIT_END_TAG;
        return true;
    }

    if (valid_symbols[RAW_TEXT] && !valid_symbols[START_TAG_NAME] && !valid_symbols[END_TAG_NAME]) {
        return scan_raw_text(scanner, lexer);
    }

    if (valid_symbols[ATTRIBUTE_ENTITY] && lexer->lookahead == '&') {
        return scan_attribute_entity(lexer, ATTRIBUTE_ENTITY);
    }

    while (iswspace(lexer->lookahead)) {
        skip(lexer);
    }
    if (valid_symbols[UNQUOTED_ATTRIBUTE_ENTITY] && lexer->lookahead == '&') {
        return scan_attribute_entity(lexer, UNQUOTED_ATTRIBUTE_ENTITY);
    }

    bool close_void = valid_symbols[IMPLICIT_END_TAG] && !valid_symbols[SELF_CLOSING_TAG_DELIMITER] &&
                      scanner->tags.size > 0 && tag_is_void(top_tag(scanner));
    if (close_void && lexer->lookahead != '<') {
        lexer->mark_end(lexer);
        pop_tag(scanner);
        lexer->result_symbol = IMPLICIT_END_TAG;
        return true;
    }

    switch (lexer->lookahead) {
        case '<':
            return scan_markup_open(scanner, lexer, valid_symbols, close_void);

        case '\0':
            if (valid_symbols[IMPLICIT_END_TAG]) {
                return scan_implicit_end_tag(scanner, lexer);
            }
            break;

        case '/':
            if (valid_symbols[SELF_CLOSING_TAG_DELIMITER]) {
                return scan_self_closing_tag_delimiter(scanner, lexer);
            }
            break;

        default:
            if ((valid_symbols[START_TAG_NAME] || valid_symbols[END_TAG_NAME] ||
                 valid_symbols[ERRONEOUS_END_TAG_NAME]) && !valid_symbols[RAW_TEXT]) {
                return valid_symbols[START_TAG_NAME] ? scan_start_tag_name(scanner, lexer)
                                                     : scan_end_tag_name(scanner, lexer, valid_symbols[END_TAG_NAME]);
            }
    }

    return false;
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
    clear_tags(scanner);
    array_delete(&scanner->tags);
    ts_free(scanner);
}
