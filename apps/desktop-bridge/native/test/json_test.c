/*
 * SPDX-License-Identifier: GPL-3.0-only
 *
 * Tests for the tray helper's JSON reader.
 *
 * This is the only hand-written parsing in the project, and it runs in C with
 * fixed buffers on input the user can influence — a machine name reaches it
 * through the tooltip, a device name through a menu label. So it is tested on
 * every platform rather than only on the one that ships it, which is why
 * json.h has no Windows dependencies.
 *
 * Run with `--parse` it reads one command line on stdin and dumps what it made
 * of it. native/test/run.mjs uses that to feed it the output of the real
 * TypeScript encoder, so the two cannot drift apart: the fixtures below cover
 * input nobody would think to generate, and the round trip covers the input
 * that is actually sent.
 */

#include <stdio.h>
#include <string.h>

#include "../windows/json.h"

static int failures = 0;
static int checks = 0;

static void check_string(const char *what, const char *got, const char *want) {
    checks++;
    if (strcmp(got, want) == 0) {
        printf("  ok   %s\n", what);
        return;
    }
    printf("  FAIL %s\n       got  \"%s\"\n       want \"%s\"\n", what, got, want);
    failures++;
}

static void check_int(const char *what, int got, int want) {
    checks++;
    if (got == want) {
        printf("  ok   %s\n", what);
        return;
    }
    printf("  FAIL %s: got %d, want %d\n", what, got, want);
    failures++;
}

/*
 * Dump what the helper made of one command, as `key=value` lines.
 *
 * Deliberately dull output: it is read by a test script, and anything cleverer
 * would need its own parser to check.
 */
static int dump_from_stdin(void) {
    static char line[8192];
    if (fgets(line, sizeof(line), stdin) == NULL) return 1;

    char field[256];
    vrmc_json_string(line, "type", field, sizeof(field));
    printf("type=%s\n", field);
    vrmc_json_string(line, "tooltip", field, sizeof(field));
    printf("tooltip=%s\n", field);

    const char *items = vrmc_json_find(line, "items");
    if (items == NULL || *items != '[') {
        printf("items=none\n");
        return 0;
    }

    const char *p = items;
    int index = 0;
    while (index < 32) {
        const char *open = strchr(p, '{');
        if (open == NULL) break;
        const char *close = vrmc_json_object_end(open);
        if (close == NULL) break;
        char object[1024];
        size_t len = (size_t)(close - open) + 1;
        if (len >= sizeof(object)) len = sizeof(object) - 1;
        memcpy(object, open, len);
        object[len] = '\0';

        char id[64];
        char label[192];
        vrmc_json_string(object, "id", id, sizeof(id));
        vrmc_json_string(object, "label", label, sizeof(label));
        printf("item=%d id=%s enabled=%d separator=%d checked=%d label=%s\n",
               index,
               id,
               vrmc_json_bool(object, "enabled", 1),
               vrmc_json_bool(object, "separator", 0),
               vrmc_json_bool(object, "checked", 0),
               label);
        index++;
        p = close + 1;
    }
    printf("count=%d\n", index);
    return 0;
}

int main(int argc, char **argv) {
    if (argc > 1 && strcmp(argv[1], "--parse") == 0) return dump_from_stdin();

    char out[128];

    /* --- the shape the bridge actually sends --- */
    const char *menu =
        "{\"type\":\"menu\",\"tooltip\":\"VRMC - 2 devices\",\"items\":["
        "{\"id\":\"status\",\"label\":\"Headset connected\",\"enabled\":false},"
        "{\"id\":\"sep0\",\"label\":\"\",\"separator\":true},"
        "{\"id\":\"code\",\"label\":\"Pairing code: K7M-2QX\"},"
        "{\"id\":\"login\",\"label\":\"Start at login\",\"checked\":true},"
        "{\"id\":\"quit\",\"label\":\"Quit VRMC\"}]}";

    vrmc_json_string(menu, "type", out, sizeof(out));
    check_string("reads the command type", out, "menu");

    vrmc_json_string(menu, "tooltip", out, sizeof(out));
    check_string("reads the tooltip", out, "VRMC - 2 devices");

    /* A nested "label" must not answer a query at the top level, and the top
     * level must not be answered by a nested key. */
    check_int("no top-level label leaks from an item",
              vrmc_json_string(menu, "label", out, sizeof(out)), 0);

    const char *items = vrmc_json_find(menu, "items");
    check_int("finds the items array", items != NULL && *items == '[', 1);

    /* Walk the array the way the helper does. */
    const char *p = items;
    int count = 0;
    char ids[8][64];
    char labels[8][128];
    int enabled[8];
    int separator[8];
    int checked[8];
    while (count < 8) {
        const char *open = strchr(p, '{');
        if (open == NULL) break;
        const char *close = vrmc_json_object_end(open);
        if (close == NULL) break;
        char object[512];
        size_t len = (size_t)(close - open) + 1;
        if (len >= sizeof(object)) len = sizeof(object) - 1;
        memcpy(object, open, len);
        object[len] = '\0';

        vrmc_json_string(object, "id", ids[count], sizeof(ids[count]));
        vrmc_json_string(object, "label", labels[count], sizeof(labels[count]));
        enabled[count] = vrmc_json_bool(object, "enabled", 1);
        separator[count] = vrmc_json_bool(object, "separator", 0);
        checked[count] = vrmc_json_bool(object, "checked", 0);
        count++;
        p = close + 1;
    }

    check_int("parses every item", count, 5);
    check_string("first item id", ids[0], "status");
    check_string("first item label", labels[0], "Headset connected");
    check_int("explicit enabled:false is honoured", enabled[0], 0);
    check_int("a missing enabled defaults to true", enabled[2], 1);
    check_int("separator is recognised", separator[1], 1);
    check_int("a normal row is not a separator", separator[2], 0);
    check_int("checked is recognised", checked[3], 1);
    check_string("last item id", ids[4], "quit");

    /* --- input that could plausibly break it --- */

    /* A machine name reaches the tooltip, and people name computers things
     * like `Ben"s Mac`. JSON.stringify escapes the quote; the reader has to
     * put it back rather than ending the string early. */
    const char *quoted = "{\"type\":\"menu\",\"tooltip\":\"Ben\\\"s Mac\",\"items\":[]}";
    vrmc_json_string(quoted, "tooltip", out, sizeof(out));
    check_string("an escaped quote survives", out, "Ben\"s Mac");

    const char *backslash = "{\"tooltip\":\"C:\\\\Users\\\\ben\",\"type\":\"menu\"}";
    vrmc_json_string(backslash, "tooltip", out, sizeof(out));
    check_string("an escaped backslash survives", out, "C:\\Users\\ben");
    vrmc_json_string(backslash, "type", out, sizeof(out));
    check_string("a key after an escaped value is still found", out, "menu");

    /* A label that happens to contain a key name must not be mistaken for one.
     * This is the bug the scanning parser exists to avoid. */
    const char *tricky =
        "{\"type\":\"menu\",\"tooltip\":\"x\",\"items\":["
        "{\"id\":\"a\",\"label\":\"\\\"type\\\":\\\"quit\\\"\"}]}";
    vrmc_json_string(tricky, "type", out, sizeof(out));
    check_string("a key inside a string value is not matched", out, "menu");

    /* Non-ASCII is transliterated rather than mangled. */
    const char *unicode = "{\"type\":\"menu\",\"tooltip\":\"caf\\u00e9\"}";
    vrmc_json_string(unicode, "tooltip", out, sizeof(out));
    check_string("a \\u escape becomes a placeholder", out, "caf?");

    /* Truncation must terminate and must not run past the buffer. */
    char small[8];
    const char *long_label = "{\"label\":\"a very long label indeed\"}";
    vrmc_json_string(long_label, "label", small, sizeof(small));
    check_string("an over-long value is truncated", small, "a very ");
    check_int("truncation terminates", (int)strlen(small), 7);

    /* Absent keys and malformed input must be survivable, not fatal. */
    check_int("a missing key reports not-found",
              vrmc_json_string(menu, "nonexistent", out, sizeof(out)), 0);
    check_string("a missing key leaves an empty string", out, "");
    check_int("a missing bool falls back", vrmc_json_bool(menu, "nope", 1), 1);
    check_int("truncated input does not hang",
              vrmc_json_string("{\"type\":\"me", "type", out, sizeof(out)), 1);
    check_int("an unterminated object has no end",
              vrmc_json_object_end("{\"a\":1") == NULL, 1);
    check_int("empty input is not a match",
              vrmc_json_string("", "type", out, sizeof(out)), 0);

    /* --- escaping on the way out --- */
    vrmc_json_escape("quit", out, sizeof(out));
    check_string("a plain id is unchanged", out, "quit");
    vrmc_json_escape("a\"b\\c", out, sizeof(out));
    check_string("quotes and backslashes are escaped", out, "a\\\"b\\\\c");
    vrmc_json_escape("a\nb", out, sizeof(out));
    check_string("a control character is escaped", out, "a\\u000ab");

    printf("\n%d/%d checks passed\n", checks - failures, checks);
    return failures == 0 ? 0 : 1;
}
