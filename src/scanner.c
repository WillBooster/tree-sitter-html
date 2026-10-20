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
    PROCESSING_INSTRUCTION,
    ELEMENT_TEXT,
    UNFINISHED_PROCESSING_INSTRUCTION,
    ATTRIBUTE_ENTITY,
    UNQUOTED_ATTRIBUTE_ENTITY,
    ATTRIBUTE_AMPERSAND,
    UNQUOTED_ATTRIBUTE_FRAGMENT,
};

typedef enum { NAMESPACE_HTML, NAMESPACE_SVG, NAMESPACE_MATH } Namespace;

typedef struct {
    Tag tag;
    unsigned count;
} TagRun;

// Consecutive identical open tags share one run, so deep repeated nesting stays cheap to scan, serialize, and restore.
typedef struct {
    Array(TagRun) tags;
    Namespace omitted_namespace;
} Scanner;

static Namespace child_namespace(Namespace current, const Tag *tag);
static Namespace namespace_after_tag(Namespace current, const Tag *tag);

#define MAX(a, b) ((a) > (b) ? (a) : (b))
#define MIN(a, b) ((a) < (b) ? (a) : (b))

static bool close_void_element(Scanner *scanner, TSLexer *lexer);
static bool scan_contiguous_attribute_content(TSLexer *lexer, const bool *valid_symbols);
static bool scan_unquoted_attribute_fragment(TSLexer *lexer);
static bool is_unquoted_attribute_content(int32_t character);
static bool is_attribute_whitespace(int32_t character);
static bool accepts_tag_suffix(TSLexer *lexer, bool closing);

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
        if (scanner->tags.size == 0) scanner->omitted_namespace = NAMESPACE_HTML;
    }
}

static void clear_tags(Scanner *scanner) {
    for (unsigned i = 0; i < scanner->tags.size; i++) {
        tag_free(&scanner->tags.contents[i].tag);
    }
    array_clear(&scanner->tags);
    scanner->omitted_namespace = NAMESPACE_HTML;
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

static unsigned retained_tag_run_start(const Scanner *scanner);
static bool namespace_boundary_tag(const Tag *tag);

static uint16_t write_unknown_tags(unsigned count, char *buffer, unsigned *size) {
    Tag unknown = tag_new();
    return write_tag_run(&unknown, MIN(count, UINT16_MAX), buffer, size);
}

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
    unsigned namespace_offset = size++;

    unsigned retained_start = retained_tag_run_start(scanner);
    unsigned unknown_count = 0;
    for (unsigned i = scanner->tags.size; i > 0 && serialized_tag_count < tag_count; i--) {
        const TagRun *run = &scanner->tags.contents[i - 1];
        if (i <= retained_start && !namespace_boundary_tag(&run->tag)) {
            unknown_count += run->count;
            continue;
        }
        if (unknown_count > 0) {
            serialized_tag_count += write_unknown_tags(MIN(unknown_count, tag_count - serialized_tag_count), buffer, &size);
            unknown_count = 0;
            if (serialized_tag_count == tag_count) break;
        }
        uint16_t count = MIN(run->count, (unsigned)(tag_count - serialized_tag_count));
        uint16_t written = write_tag_run(&run->tag, count, buffer, &size);
        serialized_tag_count += written;
        if (written < count) break;
    }
    if (unknown_count > 0 && serialized_tag_count < tag_count) {
        serialized_tag_count += write_unknown_tags(MIN(unknown_count, tag_count - serialized_tag_count), buffer, &size);
    }

    Namespace boundary = scanner->omitted_namespace;
    unsigned omitted = depth - serialized_tag_count;
    for (unsigned i = 0; i < scanner->tags.size && omitted > 0; i++) {
        const TagRun *run = &scanner->tags.contents[i];
        unsigned count = MIN(run->count, omitted);
        for (unsigned j = 0; j < count; j++) {
            Namespace next = namespace_after_tag(boundary, &run->tag);
            if (next == boundary) break;
            boundary = next;
        }
        omitted -= count;
    }
    buffer[namespace_offset] = (char)boundary;
    memcpy(&buffer[0], &serialized_tag_count, sizeof(serialized_tag_count));
    return size;
}

static unsigned serialized_run_size(const Tag *tag, unsigned count) {
    if (count == 0) return 0;
    unsigned size = serialized_tag_size(tag);
    return MIN((uint64_t)size * count, size + TAG_RUN_SIZE);
}

static unsigned retained_tag_run_start(const Scanner *scanner) {
    unsigned capacity = TREE_SITTER_SERIALIZATION_BUFFER_SIZE - 2 * sizeof(uint16_t) - 1;
    unsigned suffix_size = 0;
    for (unsigned i = 0; i < scanner->tags.size; i++) {
        const TagRun *run = &scanner->tags.contents[i];
        suffix_size += serialized_run_size(&run->tag, run->count);
    }
    if (suffix_size <= capacity) return 0;
    Array(unsigned) prefix_sizes = array_new();
    array_push(&prefix_sizes, 0);
    unsigned prefix_size = 0;
    unsigned unknown_count = 0;
    Tag unknown = tag_new();
    for (unsigned i = 0; i < scanner->tags.size; i++) {
        const TagRun *run = &scanner->tags.contents[i];
        if (namespace_boundary_tag(&run->tag)) {
            prefix_size += serialized_run_size(&unknown, unknown_count) + serialized_run_size(&run->tag, run->count);
            unknown_count = 0;
        } else {
            unknown_count += run->count;
        }
        array_push(&prefix_sizes, prefix_size + serialized_run_size(&unknown, unknown_count));
    }
    unsigned retained_start = 0;
    while (retained_start < scanner->tags.size && prefix_sizes.contents[retained_start] + suffix_size > capacity) {
        const TagRun *run = &scanner->tags.contents[retained_start++];
        suffix_size -= serialized_run_size(&run->tag, run->count);
    }
    if (prefix_sizes.contents[retained_start] + suffix_size > capacity) retained_start = 0;
    array_delete(&prefix_sizes);
    return retained_start;
}

static bool namespace_boundary_tag(const Tag *tag) {
    return tag->type == SVG || tag->type == MATH ||
           child_namespace(NAMESPACE_SVG, tag) == NAMESPACE_HTML ||
           child_namespace(NAMESPACE_MATH, tag) == NAMESPACE_HTML;
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
    scanner->omitted_namespace = (Namespace)(uint8_t)buffer[size++];

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

static inline int32_t ascii_upper(int32_t character);
static void append_utf8(String *text, uint32_t character);

static String scan_tag_name(TSLexer *lexer) {
    String tag_name = array_new();
    while (iswalnum(lexer->lookahead) || lexer->lookahead == '-' || lexer->lookahead == ':') {
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

static bool is_html_whitespace(int32_t character);
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

static bool in_html_namespace(const Scanner *scanner) {
    Namespace current = scanner->omitted_namespace;
    for (unsigned i = 0; i < scanner->tags.size; i++) {
        const TagRun *run = &scanner->tags.contents[i];
        if (current == NAMESPACE_HTML) {
            if (run->tag.type == SVG) current = NAMESPACE_SVG;
            if (run->tag.type == MATH) current = NAMESPACE_MATH;
        }
        if (i + 1 == scanner->tags.size && run->count == 1) {
            return current == NAMESPACE_HTML;
        }
        current = child_namespace(current, &run->tag);
    }
    return current == NAMESPACE_HTML;
}

static Namespace namespace_after_tag(Namespace current, const Tag *tag) {
    if (current == NAMESPACE_HTML) {
        if (tag->type == SVG) current = NAMESPACE_SVG;
        if (tag->type == MATH) current = NAMESPACE_MATH;
    }
    return child_namespace(current, tag);
}

static Namespace child_namespace(Namespace current, const Tag *tag) {
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
                if (!consumed && can_end && !accepts_tag_suffix(lexer, true)) {
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

static bool scan_implicit_end_tag(Scanner *scanner, TSLexer *lexer) {
    Tag *parent = top_tag(scanner);

    if (parent && parent->type == STYLE && lexer->eof(lexer)) {
        return false;
    }

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
            bool close_raw = (parent->type == SCRIPT || parent->type == STYLE) &&
                             !accepts_tag_suffix(lexer, true);
            tag_free(&next_tag);
            if (close_raw) {
                pop_tag(scanner);
                lexer->result_symbol = IMPLICIT_END_TAG;
            }
            return close_raw;
        }

        for (unsigned i = scanner->tags.size; i > 0; i--) {
            if (tag_eq(&scanner->tags.contents[i - 1].tag, &next_tag)) {
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

    lexer->mark_end(lexer);
    if (!accepts_tag_suffix(lexer, false)) {
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

    lexer->mark_end(lexer);
    if (valid_end_tag) {
        if (!accepts_tag_suffix(lexer, true)) {
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

static bool scan_tag_syntax(Scanner *scanner, TSLexer *lexer, const bool *valid_symbols);
static bool scan_markup_open(Scanner *scanner, TSLexer *lexer, const bool *valid_symbols, bool close_void);

static bool scan(Scanner *scanner, TSLexer *lexer, const bool *valid_symbols) {
    if (valid_symbols[IMPLICIT_END_TAG] && lexer->eof(lexer) &&
        top_tag(scanner) && top_tag(scanner)->type == SCRIPT) {
        pop_tag(scanner);
        lexer->result_symbol = IMPLICIT_END_TAG;
        return true;
    }

    bool in_content = !valid_symbols[START_TAG_NAME] && !valid_symbols[END_TAG_NAME];
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

static bool scan_tag_syntax(Scanner *scanner, TSLexer *lexer, const bool *valid_symbols) {
    bool close_void = valid_symbols[IMPLICIT_END_TAG] && !valid_symbols[SELF_CLOSING_TAG_DELIMITER] &&
                      scanner->tags.size > 0 && tag_is_void(top_tag(scanner));
    bool valid_tag_name = valid_symbols[START_TAG_NAME] || valid_symbols[END_TAG_NAME] ||
                          valid_symbols[ERRONEOUS_END_TAG_NAME];
    bool in_tag = valid_tag_name || valid_symbols[SELF_CLOSING_TAG_DELIMITER] ||
                  valid_symbols[UNQUOTED_ATTRIBUTE_ENTITY];
    if (iswspace(lexer->lookahead) && !in_tag) {
        return close_void && close_void_element(scanner, lexer);
    }

    while (is_attribute_whitespace(lexer->lookahead)) {
        skip(lexer);
    }
    if (valid_symbols[UNQUOTED_ATTRIBUTE_ENTITY] && !valid_symbols[START_TAG_NAME] && lexer->lookahead == '&') {
        return scan_attribute_entity(lexer, UNQUOTED_ATTRIBUTE_ENTITY, ATTRIBUTE_AMPERSAND);
    }

    if (close_void && lexer->lookahead != '<') {
        return close_void_element(scanner, lexer);
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
            if (valid_symbols[SELF_CLOSING_TAG_DELIMITER] && !valid_symbols[START_TAG_NAME] &&
                !valid_symbols[END_TAG_NAME]) {
                return scan_self_closing_tag_delimiter(scanner, lexer);
            }
            break;

        default:
            if (valid_tag_name && !valid_symbols[RAW_TEXT]) {
                return valid_symbols[START_TAG_NAME] ? scan_start_tag_name(scanner, lexer)
                                                     : scan_end_tag_name(scanner, lexer, valid_symbols[END_TAG_NAME]);
            }
    }

    return false;
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
    if (lexer->lookahead == '?') {
        return scan_processing_instruction(lexer, valid_symbols);
    }
    return valid_symbols[IMPLICIT_END_TAG] && scan_implicit_end_tag(scanner, lexer);
}

static bool close_void_element(Scanner *scanner, TSLexer *lexer) {
    lexer->mark_end(lexer);
    pop_tag(scanner);
    lexer->result_symbol = IMPLICIT_END_TAG;
    return true;
}

static bool scan_contiguous_attribute_content(TSLexer *lexer, const bool *valid_symbols) {
    if (valid_symbols[START_TAG_NAME] || lexer->eof(lexer)) {
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

// This lookahead consumes input: callers must mark the token end first.
// The implicit-end path inherits that boundary from scan_markup_open.
static bool accepts_tag_suffix(TSLexer *lexer, bool closing) {
    bool has_attribute_separator = iswspace(lexer->lookahead);
    while (iswspace(lexer->lookahead)) {
        advance(lexer);
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
        advance(lexer);
    }
    // An unfinished start at EOF cannot discard a later ancestor end.
    return !closing;
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
    clear_tags(scanner);
    array_delete(&scanner->tags);
    ts_free(scanner);
}
