/*
 * SPDX-License-Identifier: GPL-3.0-only
 *
 * VRMC tray helper for Windows.
 *
 * Owns one notification-area icon and nothing else. It reads newline-delimited
 * JSON commands on stdin, builds whatever menu it is told to, and writes a line
 * to stdout when something is clicked. Every decision about what the menu says
 * is made by the bridge; there is no product logic here.
 *
 * Two Windows facts shape this file:
 *
 *   1. Shell_NotifyIcon needs a window to deliver its callback messages to, and
 *      that window needs a thread pumping messages. So there is a hidden window
 *      whose only job is to receive them.
 *
 *   2. A Windows *service* cannot own a tray icon at all — services run in
 *      session 0, which has no desktop. That is why the bridge installs as a
 *      per-user login task rather than a service, and why this helper is a
 *      plain windowed process.
 *
 * Built as a GUI subsystem binary (/SUBSYSTEM:WINDOWS) so launching it never
 * flashes a console window, while stdin and stdout still work because the
 * parent hands us pipes.
 *
 * Everything Windows-facing uses the wide (W) API. The bridge speaks UTF-8 —
 * JSON.stringify leaves non-ASCII as raw UTF-8 bytes — and the tooltip carries
 * the machine's own name, so a computer called "Café" would render as mojibake
 * through the ANSI entry points. Widening once on the way in fixes that for
 * every label at the same time.
 *
 * Build:  node native/build.mjs   (from a Developer Command Prompt)
 */

#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#include <windows.h>
#include <shellapi.h>
#include <stdio.h>
#include <string.h>
#include <wchar.h>

#include "json.h"

#define WM_TRAY_CALLBACK (WM_APP + 1)
#define WM_TRAY_APPLY (WM_APP + 2)
#define WM_TRAY_QUIT (WM_APP + 3)

/* Command ids start here so they never collide with 0, which TrackPopupMenu
 * returns to mean "nothing was chosen". */
#define ID_FIRST 100
#define MAX_ITEMS 32
#define MAX_LABEL 128
#define MAX_ID 64
#define MAX_LINE 8192
#define MAX_OBJECT 1024

#define IDI_VRMC 101

typedef struct {
    char id[MAX_ID];
    wchar_t label[MAX_LABEL];
    int enabled;
    int separator;
    int checked;
} TrayItem;

/*
 * Convert a UTF-8 string from the bridge into UTF-16 for Windows.
 *
 * Invalid bytes are dropped rather than substituted: MB_ERR_INVALID_CHARS
 * would reject the whole string, and a label that loses one character still
 * reads, while a menu row that vanishes does not.
 */
static void widen(const char *utf8, wchar_t *out, int cap) {
    if (cap <= 0) return;
    out[0] = L'\0';
    int written = MultiByteToWideChar(CP_UTF8, 0, utf8, -1, out, cap);
    if (written == 0) out[0] = L'\0';
    out[cap - 1] = L'\0';
}

/* The menu the window should draw. Written by the reader thread under the
 * lock, read by the UI thread when it rebuilds. */
static CRITICAL_SECTION g_lock;
static TrayItem g_items[MAX_ITEMS];
static int g_count = 0;
static wchar_t g_tooltip[128] = L"VRMC";

static HWND g_window = NULL;
static NOTIFYICONDATAW g_icon;
static int g_icon_added = 0;

static void emit(const char *json) {
    fputs(json, stdout);
    fputc('\n', stdout);
    /* Flushed immediately: the bridge acts on clicks, and a click sitting in a
     * buffer is a menu that appears not to work. */
    fflush(stdout);
}

/* --- command handling --------------------------------------------------- */

static void apply_menu(const char *line) {
    char tooltip_utf8[256];
    if (!vrmc_json_string(line, "tooltip", tooltip_utf8, sizeof(tooltip_utf8))) {
        strcpy(tooltip_utf8, "VRMC");
    }
    wchar_t tooltip[128];
    widen(tooltip_utf8, tooltip, (int)(sizeof(tooltip) / sizeof(tooltip[0])));

    TrayItem items[MAX_ITEMS];
    int count = 0;

    const char *array = vrmc_json_find(line, "items");
    if (array != NULL && *array == '[') {
        const char *p = array;
        const char *array_end = p;
        /* Bound the scan to the array itself, so trailing keys after it can
         * never be read as further items. */
        {
            int depth = 0, in_string = 0;
            for (const char *q = p; *q != '\0'; q++) {
                if (in_string) {
                    if (*q == '\\' && q[1] != '\0') q++;
                    else if (*q == '"') in_string = 0;
                    continue;
                }
                if (*q == '"') in_string = 1;
                else if (*q == '[') depth++;
                else if (*q == ']') {
                    depth--;
                    if (depth == 0) { array_end = q; break; }
                }
            }
        }

        while (count < MAX_ITEMS) {
            const char *open = strchr(p, '{');
            if (open == NULL || open > array_end) break;
            const char *close = vrmc_json_object_end(open);
            if (close == NULL) break;

            size_t len = (size_t)(close - open) + 1;
            char object[MAX_OBJECT];
            if (len >= sizeof(object)) len = sizeof(object) - 1;
            memcpy(object, open, len);
            object[len] = '\0';

            TrayItem *item = &items[count];
            memset(item, 0, sizeof(*item));
            item->separator = vrmc_json_bool(object, "separator", 0);
            item->checked = vrmc_json_bool(object, "checked", 0);
            item->enabled = vrmc_json_bool(object, "enabled", 1);
            vrmc_json_string(object, "id", item->id, sizeof(item->id));
            char label_utf8[MAX_LABEL * 3];
            vrmc_json_string(object, "label", label_utf8, sizeof(label_utf8));
            widen(label_utf8, item->label, MAX_LABEL);
            count++;

            p = close + 1;
        }
    }

    EnterCriticalSection(&g_lock);
    memcpy(g_items, items, sizeof(TrayItem) * (size_t)count);
    g_count = count;
    memcpy(g_tooltip, tooltip, sizeof(g_tooltip));
    g_tooltip[(sizeof(g_tooltip) / sizeof(g_tooltip[0])) - 1] = L'\0';
    LeaveCriticalSection(&g_lock);

    PostMessageW(g_window, WM_TRAY_APPLY, 0, 0);
}

static DWORD WINAPI reader_thread(LPVOID unused) {
    (void)unused;
    static char line[MAX_LINE];
    while (fgets(line, sizeof(line), stdin) != NULL) {
        char type[32];
        if (!vrmc_json_string(line, "type", type, sizeof(type))) continue;
        if (strcmp(type, "menu") == 0) {
            apply_menu(line);
        } else if (strcmp(type, "quit") == 0) {
            PostMessageW(g_window, WM_TRAY_QUIT, 0, 0);
            return 0;
        }
    }
    /* stdin closed: the bridge is gone, so this icon represents nothing. */
    PostMessageW(g_window, WM_TRAY_QUIT, 0, 0);
    return 0;
}

/* --- the hidden window -------------------------------------------------- */

static void update_tooltip(void) {
    const size_t cap = sizeof(g_icon.szTip) / sizeof(g_icon.szTip[0]);
    EnterCriticalSection(&g_lock);
    wcsncpy(g_icon.szTip, g_tooltip, cap - 1);
    g_icon.szTip[cap - 1] = L'\0';
    LeaveCriticalSection(&g_lock);
    g_icon.uFlags = NIF_TIP;
    if (g_icon_added) Shell_NotifyIconW(NIM_MODIFY, &g_icon);
}

static void show_menu(void) {
    HMENU menu = CreatePopupMenu();
    if (menu == NULL) return;

    EnterCriticalSection(&g_lock);
    for (int i = 0; i < g_count; i++) {
        TrayItem *item = &g_items[i];
        if (item->separator) {
            AppendMenuW(menu, MF_SEPARATOR, 0, NULL);
            continue;
        }
        UINT flags = MF_STRING;
        if (!item->enabled || item->id[0] == '\0') flags |= MF_GRAYED;
        if (item->checked) flags |= MF_CHECKED;
        AppendMenuW(menu, flags, (UINT_PTR)(ID_FIRST + i), item->label);
    }
    LeaveCriticalSection(&g_lock);

    POINT cursor;
    GetCursorPos(&cursor);
    /* Required, and easy to miss: without foregrounding this window first, the
     * menu refuses to close when the user clicks elsewhere and is left stuck
     * on screen. */
    SetForegroundWindow(g_window);
    int chosen = (int)TrackPopupMenu(
        menu,
        TPM_RIGHTBUTTON | TPM_RETURNCMD | TPM_NONOTIFY,
        cursor.x, cursor.y, 0, g_window, NULL);
    PostMessageW(g_window, WM_NULL, 0, 0);
    DestroyMenu(menu);

    if (chosen < ID_FIRST) return;
    int index = chosen - ID_FIRST;

    char id[MAX_ID];
    id[0] = '\0';
    EnterCriticalSection(&g_lock);
    int valid = index >= 0 && index < g_count;
    if (valid) {
        strncpy(id, g_items[index].id, sizeof(id) - 1);
        id[sizeof(id) - 1] = '\0';
    }
    LeaveCriticalSection(&g_lock);
    if (!valid || id[0] == '\0') return;

    char escaped[MAX_ID * 6];
    vrmc_json_escape(id, escaped, sizeof(escaped));
    char json[sizeof(escaped) + 32];
    snprintf(json, sizeof(json), "{\"type\":\"click\",\"id\":\"%s\"}", escaped);
    emit(json);
}

static LRESULT CALLBACK window_proc(HWND hwnd, UINT msg, WPARAM wp, LPARAM lp) {
    switch (msg) {
        case WM_TRAY_CALLBACK:
            /* Both buttons open the menu. There is no separate primary action
             * worth guessing at, and a left click that does nothing reads as a
             * broken icon. */
            if (LOWORD(lp) == WM_RBUTTONUP || LOWORD(lp) == WM_LBUTTONUP) {
                show_menu();
            }
            return 0;
        case WM_TRAY_APPLY:
            update_tooltip();
            return 0;
        case WM_TRAY_QUIT:
            PostQuitMessage(0);
            return 0;
        case WM_DESTROY:
            PostQuitMessage(0);
            return 0;
        default:
            return DefWindowProcW(hwnd, msg, wp, lp);
    }
}

int WINAPI WinMain(HINSTANCE instance, HINSTANCE prev, LPSTR cmdline, int show) {
    (void)prev; (void)cmdline; (void)show;

    InitializeCriticalSection(&g_lock);

    WNDCLASSW cls;
    memset(&cls, 0, sizeof(cls));
    cls.lpfnWndProc = window_proc;
    cls.hInstance = instance;
    cls.lpszClassName = L"VrmcTrayWindow";
    if (RegisterClassW(&cls) == 0) return 1;

    /* HWND_MESSAGE would be cheaper but a message-only window cannot be
     * foregrounded, and SetForegroundWindow above is what makes the popup menu
     * dismiss properly. So: a real window, never shown. */
    g_window = CreateWindowExW(
        0, L"VrmcTrayWindow", L"VRMC", 0,
        0, 0, 0, 0, NULL, NULL, instance, NULL);
    if (g_window == NULL) return 1;

    memset(&g_icon, 0, sizeof(g_icon));
    g_icon.cbSize = sizeof(g_icon);
    g_icon.hWnd = g_window;
    g_icon.uID = 1;
    g_icon.uFlags = NIF_ICON | NIF_MESSAGE | NIF_TIP;
    g_icon.uCallbackMessage = WM_TRAY_CALLBACK;
    g_icon.hIcon = LoadIconW(instance, MAKEINTRESOURCEW(IDI_VRMC));
    if (g_icon.hIcon == NULL) {
        g_icon.hIcon = LoadIconW(NULL, IDI_APPLICATION);
    }
    wcscpy(g_icon.szTip, L"VRMC");
    g_icon_added = Shell_NotifyIconW(NIM_ADD, &g_icon) ? 1 : 0;

    emit("{\"type\":\"ready\"}");
    CreateThread(NULL, 0, reader_thread, NULL, 0, NULL);

    MSG msg;
    while (GetMessageW(&msg, NULL, 0, 0) > 0) {
        TranslateMessage(&msg);
        DispatchMessageW(&msg);
    }

    if (g_icon_added) Shell_NotifyIconW(NIM_DELETE, &g_icon);
    DeleteCriticalSection(&g_lock);
    return 0;
}
