/*
 * SPDX-License-Identifier: GPL-3.0-only
 *
 * Just enough JSON to read a tray command.
 *
 * The bridge is the only thing that ever writes to the helper's stdin, and it
 * emits a fixed, flat shape produced by JSON.stringify. A general parser would
 * be more code than the rest of the helper, so this reads exactly the fields
 * that shape contains and ignores everything else. Anything it does not
 * understand is skipped rather than guessed at.
 *
 * Deliberately free of Windows headers: that is what lets it be compiled and
 * tested on any machine, which matters because it is the only hand-written
 * parsing in the project and the one part of the helper that could plausibly
 * be wrong in a way nobody notices until a menu label contains a quote.
 * See native/test/json_test.c.
 */

#ifndef VRMC_TRAY_JSON_H
#define VRMC_TRAY_JSON_H

#include <stddef.h>
#include <stdio.h>
#include <string.h>

/*
 * Find the value of `key` at the top level of the object starting at `p`.
 *
 * Scans rather than pattern-matches, so a key appearing inside a *string*
 * value never matches: a label of `"items"` would otherwise be mistaken for
 * the items array and take the menu with it. Nested objects are skipped, which
 * is what keeps an item's own "label" from answering a query for the
 * command's.
 */
static const char *vrmc_json_find(const char *p, const char *key) {
    size_t key_len = strlen(key);
    int depth = 0;
    int in_string = 0;
    const char *string_start = NULL;

    for (; *p != '\0'; p++) {
        if (in_string) {
            if (*p == '\\' && p[1] != '\0') {
                p++;
                continue;
            }
            if (*p != '"') continue;
            in_string = 0;
            /* A string that closes at depth 1 and is followed by a colon is a
             * key of the object we are reading. */
            if (depth == 1 && (size_t)(p - string_start) == key_len &&
                strncmp(string_start, key, key_len) == 0) {
                const char *after = p + 1;
                while (*after == ' ' || *after == '\t') after++;
                if (*after == ':') {
                    after++;
                    while (*after == ' ' || *after == '\t') after++;
                    return after;
                }
            }
            continue;
        }
        if (*p == '"') {
            in_string = 1;
            string_start = p + 1;
        } else if (*p == '{' || *p == '[') {
            depth++;
        } else if (*p == '}' || *p == ']') {
            depth--;
            if (depth <= 0) return NULL;
        }
    }
    return NULL;
}

/*
 * Copy the string value of `key` into `out`, honouring the escapes
 * JSON.stringify can produce. Returns 1 when the key was found.
 *
 * The result is UTF-8, byte for byte, because that is what arrives: the
 * encoder escapes quotes, backslashes and control characters and leaves
 * everything else alone. The caller widens it before it reaches Windows.
 *
 * `out` is always terminated, and never written past `cap - 1`. A value longer
 * than the buffer is truncated rather than refused: a clipped menu label is a
 * cosmetic problem, and rejecting the whole command over one would lose the
 * rest of the menu with it.
 */
static int vrmc_json_string(const char *p, const char *key, char *out, size_t cap) {
    if (cap == 0) return 0;
    out[0] = '\0';
    const char *at = vrmc_json_find(p, key);
    if (at == NULL || *at != '"') return 0;
    at++;

    size_t n = 0;
    while (*at != '\0' && *at != '"') {
        char ch;
        if (*at == '\\' && at[1] != '\0') {
            at++;
            switch (*at) {
                case 'n': ch = ' '; break;  /* a menu label is one line */
                case 't': ch = ' '; break;
                case 'r': at++; continue;
                case 'b': at++; continue;
                case 'f': at++; continue;
                case 'u': {
                    /* JSON.stringify emits non-ASCII as raw UTF-8, which falls
                     * through the plain path below and reaches the menu intact.
                     * A \u escape therefore only appears for a control
                     * character or an unpaired surrogate — nothing that belongs
                     * in a label — so it becomes '?' rather than being decoded.
                     */
                    size_t remaining = strlen(at);
                    at += remaining >= 5 ? 4 : remaining;
                    ch = '?';
                    break;
                }
                default: ch = *at; break;  /* \" \\ \/ */
            }
            at++;
        } else {
            ch = *at++;
        }
        if (n + 1 < cap) out[n++] = ch;
    }
    out[n] = '\0';
    return 1;
}

/* Read a boolean field, returning `fallback` when the key is absent. */
static int vrmc_json_bool(const char *p, const char *key, int fallback) {
    const char *at = vrmc_json_find(p, key);
    if (at == NULL) return fallback;
    if (strncmp(at, "true", 4) == 0) return 1;
    if (strncmp(at, "false", 5) == 0) return 0;
    return fallback;
}

/*
 * Find the end of the JSON object beginning at `start`, tracking nesting and
 * ignoring braces that appear inside strings.
 */
static const char *vrmc_json_object_end(const char *start) {
    int depth = 0;
    int in_string = 0;
    for (const char *p = start; *p != '\0'; p++) {
        if (in_string) {
            if (*p == '\\' && p[1] != '\0') p++;
            else if (*p == '"') in_string = 0;
            continue;
        }
        if (*p == '"') in_string = 1;
        else if (*p == '{') depth++;
        else if (*p == '}') {
            depth--;
            if (depth == 0) return p;
        }
    }
    return NULL;
}

/*
 * Escape `text` into `out` as a JSON string body (no surrounding quotes).
 *
 * Used for the id echoed back on a click. Ids are ours and contain nothing
 * exotic, but building JSON by string concatenation without escaping is
 * exactly how a helper ends up emitting a line the bridge cannot parse.
 */
static void vrmc_json_escape(const char *text, char *out, size_t cap) {
    if (cap == 0) return;
    size_t n = 0;
    for (const unsigned char *p = (const unsigned char *)text; *p != '\0'; p++) {
        const char *escape = NULL;
        char buffer[8];
        if (*p == '"') escape = "\\\"";
        else if (*p == '\\') escape = "\\\\";
        else if (*p < 0x20 || *p == 0x7f) {
            snprintf(buffer, sizeof(buffer), "\\u%04x", (unsigned)*p);
            escape = buffer;
        }
        if (escape != NULL) {
            size_t len = strlen(escape);
            if (n + len + 1 >= cap) break;
            memcpy(out + n, escape, len);
            n += len;
            continue;
        }
        if (n + 2 >= cap) break;
        out[n++] = (char)*p;
    }
    out[n] = '\0';
}

#endif /* VRMC_TRAY_JSON_H */
