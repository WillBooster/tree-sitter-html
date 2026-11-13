#ifndef TREE_SITTER_HTML_TAG_H_
#define TREE_SITTER_HTML_TAG_H_

#include "tree_sitter/array.h"
#include "tree_sitter/parser.h"

#include <string.h>
#include <wctype.h>

#define TAG_NAME_MAX_LENGTH 14

typedef enum {
    AREA,
    BASE,
    BASEFONT,
    BGSOUND,
    BR,
    COL,
    COMMAND,
    EMBED,
    FRAME,
    HR,
    IMAGE,
    IMG,
    INPUT,
    ISINDEX,
    KEYGEN,
    LINK,
    MENUITEM,
    META,
    NEXTID,
    PARAM,
    SOURCE,
    TRACK,
    WBR,
    END_OF_VOID_TAGS,

    A,
    ANNOTATION_XML,
    ABBR,
    ADDRESS,
    ARTICLE,
    ASIDE,
    AUDIO,
    B,
    BDI,
    BDO,
    BLOCKQUOTE,
    BODY,
    BUTTON,
    CANVAS,
    CAPTION,
    CITE,
    CODE,
    COLGROUP,
    DATA,
    DATALIST,
    DD,
    DEL,
    DETAILS,
    DFN,
    DIALOG,
    DIV,
    DL,
    DT,
    EM,
    FIELDSET,
    FIGCAPTION,
    FIGURE,
    FOOTER,
    FORM,
    H1,
    H2,
    H3,
    H4,
    H5,
    H6,
    HEAD,
    HEADER,
    HGROUP,
    HTML,
    I,
    IFRAME,
    INS,
    KBD,
    LABEL,
    LEGEND,
    LI,
    MAIN,
    MAP,
    MARK,
    MATH,
    MENU,
    METER,
    NAV,
    NOSCRIPT,
    OBJECT,
    OL,
    OPTGROUP,
    OPTION,
    OUTPUT,
    P,
    PICTURE,
    PRE,
    PROGRESS,
    Q,
    RB,
    RP,
    RT,
    RTC,
    RUBY,
    S,
    SAMP,
    SCRIPT,
    SECTION,
    SELECT,
    SLOT,
    SMALL,
    SPAN,
    STRONG,
    STYLE,
    SUB,
    SUMMARY,
    SUP,
    SVG,
    TABLE,
    TBODY,
    TD,
    TEMPLATE,
    TEXTAREA,
    TFOOT,
    TH,
    THEAD,
    TIME,
    TITLE,
    TR,
    U,
    UL,
    VAR,
    VIDEO,

    ANNOTATION_XML_HTML,
    CUSTOM,

    END_,
} TagType;

typedef Array(char) String;

#define TAG_INLINE_CAPACITY (sizeof(String) >= 16 ? 22 : 14)
#define TAG_HEAP_MARKER 0xFF

typedef struct {
    char tag_name[TAG_NAME_MAX_LENGTH + 1];
    uint8_t name_length;
    uint8_t tag_type;
} TagMapEntry;

typedef struct {
    union {
        char inline_name[TAG_INLINE_CAPACITY];
        String custom_tag_name;
    };
    uint8_t type;
    uint8_t inline_size;
} Tag;

#define TAG_MAP_ENTRY(name, type) {name, sizeof(name) - 1, type}

static const TagMapEntry TAG_TYPES_BY_TAG_NAME[] = {
    TAG_MAP_ENTRY("A", A),
    TAG_MAP_ENTRY("ABBR", ABBR),
    TAG_MAP_ENTRY("ADDRESS", ADDRESS),
    TAG_MAP_ENTRY("ANNOTATION-XML", ANNOTATION_XML),
    TAG_MAP_ENTRY("AREA", AREA),
    TAG_MAP_ENTRY("ARTICLE", ARTICLE),
    TAG_MAP_ENTRY("ASIDE", ASIDE),
    TAG_MAP_ENTRY("AUDIO", AUDIO),
    TAG_MAP_ENTRY("B", B),
    TAG_MAP_ENTRY("BASE", BASE),
    TAG_MAP_ENTRY("BASEFONT", BASEFONT),
    TAG_MAP_ENTRY("BDI", BDI),
    TAG_MAP_ENTRY("BDO", BDO),
    TAG_MAP_ENTRY("BGSOUND", BGSOUND),
    TAG_MAP_ENTRY("BLOCKQUOTE", BLOCKQUOTE),
    TAG_MAP_ENTRY("BODY", BODY),
    TAG_MAP_ENTRY("BR", BR),
    TAG_MAP_ENTRY("BUTTON", BUTTON),
    TAG_MAP_ENTRY("CANVAS", CANVAS),
    TAG_MAP_ENTRY("CAPTION", CAPTION),
    TAG_MAP_ENTRY("CITE", CITE),
    TAG_MAP_ENTRY("CODE", CODE),
    TAG_MAP_ENTRY("COL", COL),
    TAG_MAP_ENTRY("COLGROUP", COLGROUP),
    TAG_MAP_ENTRY("COMMAND", COMMAND),
    TAG_MAP_ENTRY("DATA", DATA),
    TAG_MAP_ENTRY("DATALIST", DATALIST),
    TAG_MAP_ENTRY("DD", DD),
    TAG_MAP_ENTRY("DEL", DEL),
    TAG_MAP_ENTRY("DETAILS", DETAILS),
    TAG_MAP_ENTRY("DFN", DFN),
    TAG_MAP_ENTRY("DIALOG", DIALOG),
    TAG_MAP_ENTRY("DIV", DIV),
    TAG_MAP_ENTRY("DL", DL),
    TAG_MAP_ENTRY("DT", DT),
    TAG_MAP_ENTRY("EM", EM),
    TAG_MAP_ENTRY("EMBED", EMBED),
    TAG_MAP_ENTRY("FIELDSET", FIELDSET),
    TAG_MAP_ENTRY("FIGCAPTION", FIGCAPTION),
    TAG_MAP_ENTRY("FIGURE", FIGURE),
    TAG_MAP_ENTRY("FOOTER", FOOTER),
    TAG_MAP_ENTRY("FORM", FORM),
    TAG_MAP_ENTRY("FRAME", FRAME),
    TAG_MAP_ENTRY("H1", H1),
    TAG_MAP_ENTRY("H2", H2),
    TAG_MAP_ENTRY("H3", H3),
    TAG_MAP_ENTRY("H4", H4),
    TAG_MAP_ENTRY("H5", H5),
    TAG_MAP_ENTRY("H6", H6),
    TAG_MAP_ENTRY("HEAD", HEAD),
    TAG_MAP_ENTRY("HEADER", HEADER),
    TAG_MAP_ENTRY("HGROUP", HGROUP),
    TAG_MAP_ENTRY("HR", HR),
    TAG_MAP_ENTRY("HTML", HTML),
    TAG_MAP_ENTRY("I", I),
    TAG_MAP_ENTRY("IFRAME", IFRAME),
    TAG_MAP_ENTRY("IMAGE", IMAGE),
    TAG_MAP_ENTRY("IMG", IMG),
    TAG_MAP_ENTRY("INPUT", INPUT),
    TAG_MAP_ENTRY("INS", INS),
    TAG_MAP_ENTRY("ISINDEX", ISINDEX),
    TAG_MAP_ENTRY("KBD", KBD),
    TAG_MAP_ENTRY("KEYGEN", KEYGEN),
    TAG_MAP_ENTRY("LABEL", LABEL),
    TAG_MAP_ENTRY("LEGEND", LEGEND),
    TAG_MAP_ENTRY("LI", LI),
    TAG_MAP_ENTRY("LINK", LINK),
    TAG_MAP_ENTRY("MAIN", MAIN),
    TAG_MAP_ENTRY("MAP", MAP),
    TAG_MAP_ENTRY("MARK", MARK),
    TAG_MAP_ENTRY("MATH", MATH),
    TAG_MAP_ENTRY("MENU", MENU),
    TAG_MAP_ENTRY("MENUITEM", MENUITEM),
    TAG_MAP_ENTRY("META", META),
    TAG_MAP_ENTRY("METER", METER),
    TAG_MAP_ENTRY("NAV", NAV),
    TAG_MAP_ENTRY("NEXTID", NEXTID),
    TAG_MAP_ENTRY("NOSCRIPT", NOSCRIPT),
    TAG_MAP_ENTRY("OBJECT", OBJECT),
    TAG_MAP_ENTRY("OL", OL),
    TAG_MAP_ENTRY("OPTGROUP", OPTGROUP),
    TAG_MAP_ENTRY("OPTION", OPTION),
    TAG_MAP_ENTRY("OUTPUT", OUTPUT),
    TAG_MAP_ENTRY("P", P),
    TAG_MAP_ENTRY("PARAM", PARAM),
    TAG_MAP_ENTRY("PICTURE", PICTURE),
    TAG_MAP_ENTRY("PRE", PRE),
    TAG_MAP_ENTRY("PROGRESS", PROGRESS),
    TAG_MAP_ENTRY("Q", Q),
    TAG_MAP_ENTRY("RB", RB),
    TAG_MAP_ENTRY("RP", RP),
    TAG_MAP_ENTRY("RT", RT),
    TAG_MAP_ENTRY("RTC", RTC),
    TAG_MAP_ENTRY("RUBY", RUBY),
    TAG_MAP_ENTRY("S", S),
    TAG_MAP_ENTRY("SAMP", SAMP),
    TAG_MAP_ENTRY("SCRIPT", SCRIPT),
    TAG_MAP_ENTRY("SECTION", SECTION),
    TAG_MAP_ENTRY("SELECT", SELECT),
    TAG_MAP_ENTRY("SLOT", SLOT),
    TAG_MAP_ENTRY("SMALL", SMALL),
    TAG_MAP_ENTRY("SOURCE", SOURCE),
    TAG_MAP_ENTRY("SPAN", SPAN),
    TAG_MAP_ENTRY("STRONG", STRONG),
    TAG_MAP_ENTRY("STYLE", STYLE),
    TAG_MAP_ENTRY("SUB", SUB),
    TAG_MAP_ENTRY("SUMMARY", SUMMARY),
    TAG_MAP_ENTRY("SUP", SUP),
    TAG_MAP_ENTRY("SVG", SVG),
    TAG_MAP_ENTRY("TABLE", TABLE),
    TAG_MAP_ENTRY("TBODY", TBODY),
    TAG_MAP_ENTRY("TD", TD),
    TAG_MAP_ENTRY("TEMPLATE", TEMPLATE),
    TAG_MAP_ENTRY("TEXTAREA", TEXTAREA),
    TAG_MAP_ENTRY("TFOOT", TFOOT),
    TAG_MAP_ENTRY("TH", TH),
    TAG_MAP_ENTRY("THEAD", THEAD),
    TAG_MAP_ENTRY("TIME", TIME),
    TAG_MAP_ENTRY("TITLE", TITLE),
    TAG_MAP_ENTRY("TR", TR),
    TAG_MAP_ENTRY("TRACK", TRACK),
    TAG_MAP_ENTRY("U", U),
    TAG_MAP_ENTRY("UL", UL),
    TAG_MAP_ENTRY("VAR", VAR),
    TAG_MAP_ENTRY("VIDEO", VIDEO),
    TAG_MAP_ENTRY("WBR", WBR),
};

#undef TAG_MAP_ENTRY

static const bool TAG_TYPES_DISALLOWED_IN_PARAGRAPHS[END_] = {
    [ADDRESS] = true,    [ARTICLE] = true, [ASIDE] = true,  [BLOCKQUOTE] = true, [DETAILS] = true,
    [DIV] = true,        [DL] = true,      [FIELDSET] = true, [FIGCAPTION] = true, [FIGURE] = true,
    [FOOTER] = true,     [FORM] = true,    [H1] = true,     [H2] = true,         [H3] = true,
    [H4] = true,         [H5] = true,      [H6] = true,     [HEADER] = true,     [HR] = true,
    [MAIN] = true,       [NAV] = true,     [OL] = true,     [P] = true,          [PRE] = true,
    [SECTION] = true,
};

static const bool TAG_TYPES_FOREIGN_BREAKOUT[END_] = {
    [B] = true,          [BLOCKQUOTE] = true, [BODY] = true,  [BR] = true,     [CODE] = true,
    [DD] = true,         [DIV] = true,        [DL] = true,    [DT] = true,     [EM] = true,
    [EMBED] = true,      [H1] = true,         [H2] = true,    [H3] = true,     [H4] = true,
    [H5] = true,         [H6] = true,         [HEAD] = true,  [HR] = true,     [I] = true,
    [IMG] = true,        [LI] = true,         [MENU] = true,  [META] = true,   [OL] = true,
    [P] = true,          [PRE] = true,        [RUBY] = true,  [S] = true,      [SMALL] = true,
    [SPAN] = true,       [STRONG] = true,     [SUB] = true,   [SUP] = true,    [TABLE] = true,
    [U] = true,          [UL] = true,         [VAR] = true,
};

static const bool TAG_TYPES_IMPLICIT_END_ON_OPEN[END_] = {
    [BODY] = true, [COLGROUP] = true, [DD] = true,       [DT] = true, [HEAD] = true,
    [HTML] = true, [LI] = true,       [OPTGROUP] = true, [P] = true,  [RB] = true,
    [RP] = true,   [RT] = true,       [TD] = true,       [TH] = true, [TR] = true,
};

static inline const char *tag_custom_name(const Tag *tag, unsigned *size);
static void scan_custom_tag_tail(TSLexer *lexer, Tag *tag, const char *prefix, unsigned length);
static inline Tag tag_from_slice(const char *contents, unsigned size);
static TagType tag_type_for_name_slice(const char *contents, unsigned size);
static int compare_tag_entry(const char *contents, unsigned size, const TagMapEntry *entry);
static inline bool is_tag_name_char(int32_t character);
static inline bool is_html_whitespace(int32_t character);
static inline int32_t ascii_upper(int32_t character);
static void append_utf8(String *text, uint32_t character);
static bool slice_eq(const char *contents, unsigned size, const char *expected, unsigned expected_size);

static inline bool at_eof(const TSLexer *lexer) {
    return lexer->lookahead == 0 && lexer->eof(lexer);
}

static inline bool is_unicode_whitespace(int32_t c) {
    return c >= 0 && (c < 0x80 ? (c == ' ' || (uint32_t)(c - '\t') < 5) : iswspace((wint_t)c) != 0);
}

#define SLICE_EQ_LITERAL(contents, size, literal) \
    slice_eq((contents), (size), (literal), sizeof(literal) - 1)

#define TAG_CUSTOM_EQ(tag, literal) \
    (sizeof(char[sizeof(literal) - 1 <= TAG_INLINE_CAPACITY ? 1 : -1]) && \
     SLICE_EQ_LITERAL((tag)->inline_name, (tag)->inline_size, (literal)))

static inline const char *tag_custom_name(const Tag *tag, unsigned *size) {
    if (tag->inline_size == TAG_HEAP_MARKER) {
        *size = tag->custom_tag_name.size;
        return tag->custom_tag_name.contents;
    }
    *size = tag->inline_size;
    return tag->inline_name;
}

static bool scan_tag(TSLexer *lexer, Tag *tag) {
    *tag = (Tag){.type = CUSTOM, .inline_size = 0};
    int32_t first = ascii_upper(lexer->lookahead);
    if (first < 'A' || first > 'Z') return false;
    char buffer[32];
    unsigned length = 0;
    while (is_tag_name_char(lexer->lookahead)) {
        int32_t character = ascii_upper(lexer->lookahead);
        if (character < 0x80 && length < sizeof(buffer)) {
            buffer[length++] = (char)character;
            lexer->advance(lexer, false);
            continue;
        }
        scan_custom_tag_tail(lexer, tag, buffer, length);
        return true;
    }
    *tag = tag_from_slice(buffer, length);
    return true;
}

static void scan_custom_tag_tail(TSLexer *lexer, Tag *tag, const char *prefix, unsigned length) {
    String *name = &tag->custom_tag_name;
    *name = (String)array_new();
    tag->inline_size = TAG_HEAP_MARKER;
    array_reserve(name, length + 16);
    if (length > 0) {
        memcpy(name->contents, prefix, length);
        name->size = length;
    }
    do {
        append_utf8(name, ascii_upper(lexer->lookahead));
        lexer->advance(lexer, false);
    } while (is_tag_name_char(lexer->lookahead));
}

static inline Tag tag_from_slice(const char *contents, unsigned size) {
    Tag tag = {.type = (uint8_t)tag_type_for_name_slice(contents, size), .inline_size = 0};
    if (tag.type != CUSTOM || size == 0) return tag;
    if (size <= TAG_INLINE_CAPACITY) {
        memcpy(tag.inline_name, contents, size);
        tag.inline_size = (uint8_t)size;
        return tag;
    }
    tag.custom_tag_name = (String)array_new();
    tag.inline_size = TAG_HEAP_MARKER;
    array_reserve(&tag.custom_tag_name, size);
    memcpy(tag.custom_tag_name.contents, contents, size);
    tag.custom_tag_name.size = size;
    return tag;
}

static TagType tag_type_for_name_slice(const char *contents, unsigned size) {
    if (size == 0 || size > TAG_NAME_MAX_LENGTH) return CUSTOM;
    unsigned low = 0;
    unsigned high = sizeof(TAG_TYPES_BY_TAG_NAME) / sizeof(TAG_TYPES_BY_TAG_NAME[0]);
    while (low < high) {
        unsigned middle = low + (high - low) / 2;
        const TagMapEntry *entry = &TAG_TYPES_BY_TAG_NAME[middle];
        int order = compare_tag_entry(contents, size, entry);
        if (order < 0) {
            high = middle;
        } else if (order > 0) {
            low = middle + 1;
        } else {
            return (TagType)entry->tag_type;
        }
    }
    return CUSTOM;
}

static int compare_tag_entry(const char *contents, unsigned size, const TagMapEntry *entry) {
    unsigned min_length = size < entry->name_length ? size : entry->name_length;
    for (unsigned i = 0; i < min_length; i++) {
        int diff = (uint8_t)contents[i] - (uint8_t)entry->tag_name[i];
        if (diff != 0) return diff;
    }
    return (int)size - (int)entry->name_length;
}

static inline void tag_free(Tag *tag) {
    if (tag->type == CUSTOM && tag->inline_size == TAG_HEAP_MARKER) {
        array_delete(&tag->custom_tag_name);
    }
}

static inline bool tag_is_void(const Tag *self) {
    return self->type < END_OF_VOID_TAGS;
}

static inline bool tag_eq(const Tag *self, const Tag *other) {
    TagType self_type = self->type == ANNOTATION_XML_HTML ? ANNOTATION_XML : (TagType)self->type;
    TagType other_type = other->type == ANNOTATION_XML_HTML ? ANNOTATION_XML : (TagType)other->type;
    if (self_type != other_type) return false;
    if (self->type == CUSTOM) {
        unsigned self_size = 0;
        unsigned other_size = 0;
        const char *self_contents = tag_custom_name(self, &self_size);
        const char *other_contents = tag_custom_name(other, &other_size);
        return slice_eq(self_contents, self_size, other_contents, other_size);
    }
    return true;
}

static bool slice_eq(const char *contents, unsigned size, const char *expected, unsigned expected_size) {
    if (size != expected_size) return false;
    for (unsigned i = 0; i < size; i++) {
        if (contents[i] != expected[i]) return false;
    }
    return true;
}

static bool tag_can_contain(Tag *self, const Tag *other) {
    TagType child = other->type;

    switch (self->type) {
        case LI:
            return child != LI;

        case DT:
        case DD:
            return child != DT && child != DD;

        case P:
            return !TAG_TYPES_DISALLOWED_IN_PARAGRAPHS[child];

        case COLGROUP:
            return child == COL;

        case RB:
        case RT:
        case RP:
            return child != RB && child != RT && child != RP;

        case OPTGROUP:
            return child != OPTGROUP;

        case TR:
            return child != TR;

        case TD:
        case TH:
            return child != TD && child != TH && child != TR;

        default:
            return true;
    }
}

static inline const char *tag_raw_end_name(const Tag *tag, unsigned *length) {
    if (tag->type == TEXTAREA) {
        *length = 8;
        return "TEXTAREA";
    }
    if (tag->type == TITLE) {
        *length = 5;
        return "TITLE";
    }
    if (tag->type == IFRAME) {
        *length = 6;
        return "IFRAME";
    }
    return tag_custom_name(tag, length);
}

static inline bool is_tag_name_char(int32_t character) {
    return character != 0 && !is_html_whitespace(character) && character != '/' && character != '>';
}

static inline bool is_html_whitespace(int32_t character) {
    return character == ' ' || character == '\t' || character == '\n' || character == '\r' || character == '\f';
}

static inline int32_t ascii_upper(int32_t character) {
    return character >= 'a' && character <= 'z' ? character - 'a' + 'A' : character;
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

#endif
