#!/usr/bin/env python3
"""Write the unsigned Satchel Shortcut template (D-7).

Usage: python3 -I shortcut/build-shortcut.py [OUT]

OUT defaults to shortcut/Satchel.unsigned.shortcut next to this script. The
output is a binary plist holding only placeholders (WORKER_URL_PLACEHOLDER,
KEY_PLACEHOLDER), never a real Worker URL or key. Signing is a separate step.

The output is deterministic: UUIDs come from uuid5 over fixed names and plistlib
sorts keys, so a re-run with the same glyph.txt is byte-identical.

Icon: read from shortcut/glyph.txt when it exists, else the default (bookmark
glyph, gray). glyph.txt is `key = value` lines, `#` starts a comment:
    glyph = 59670        # Shortcuts glyph number, or `bookmark`
    color = gray         # a Shortcuts colour name below, or its number
"""

import pathlib
import plistlib
import sys
import uuid

HERE = pathlib.Path(__file__).resolve().parent
GLYPH_FILE = HERE / "glyph.txt"
DEFAULT_OUT = HERE / "Satchel.unsigned.shortcut"

URL_PLACEHOLDER = "WORKER_URL_PLACEHOLDER"
KEY_PLACEHOLDER = "KEY_PLACEHOLDER"
OBJ = "￼"  # Shortcuts' inline-variable marker inside a text token

# Shortcuts' fixed icon palette (names as in Cherri's shortcut.go).
COLORS = {
    "red": 4282601983, "darkorange": 4251333119, "orange": 4271458815,
    "yellow": 4274264319, "green": 4292093695, "teal": 431817727,
    "lightblue": 1440408063, "blue": 463140863, "darkblue": 946986751,
    "violet": 2071128575, "purple": 3679049983, "pink": 3980825855,
    "darkgray": 255, "gray": 3031607807, "taupe": 2846468607,
}
GLYPHS = {"bookmark": 59670}
DEFAULT_GLYPH, DEFAULT_COLOR = "bookmark", "gray"

UUID_NS = uuid.uuid5(uuid.NAMESPACE_URL, "satchel:shortcut")


def uid(name):
    return str(uuid.uuid5(UUID_NS, name)).upper()


# ---- icon -------------------------------------------------------------------

def resolve(value, table, what):
    value = value.strip().lower()
    if value.isdigit():
        return int(value)
    if value in table:
        return table[value]
    sys.exit(f"build-shortcut: unknown {what} {value!r} in {GLYPH_FILE.name}")


def read_icon():
    glyph, color, source = DEFAULT_GLYPH, DEFAULT_COLOR, "default"
    if GLYPH_FILE.exists():
        source = str(GLYPH_FILE.relative_to(HERE.parent))
        for n, line in enumerate(GLYPH_FILE.read_text(encoding="utf-8").splitlines(), 1):
            line = line.split("#", 1)[0].strip()
            if not line:
                continue
            key, sep, value = line.partition("=")
            key = key.strip().lower()
            if not sep or key not in ("glyph", "color", "colour"):
                sys.exit(f"build-shortcut: {GLYPH_FILE.name}:{n}: expected `glyph = ...` or `color = ...`")
            if key == "glyph":
                glyph = value
            else:
                color = value
    g, c = resolve(str(glyph), GLYPHS, "glyph"), resolve(str(color), COLORS, "color")
    print(f"icon: glyph {glyph.strip()} ({g}), color {color.strip()} ({c}) from {source}")
    return {"WFWorkflowIconGlyphNumber": g, "WFWorkflowIconStartColor": c}


# ---- plist shapes (L5 probe) ------------------------------------------------

def output(action_uuid, name, coerce=None):
    """Reference to an earlier action's output (a magic variable)."""
    ref = {"Type": "ActionOutput", "OutputUUID": action_uuid, "OutputName": name}
    if coerce:
        ref["Aggrandizements"] = [{"Type": "WFCoercionVariableAggrandizement", "CoercionItemClass": coerce}]
    return ref


def shortcut_input(coerce=None):
    ref = {"Type": "ExtensionInput"}
    if coerce:
        ref["Aggrandizements"] = [{"Type": "WFCoercionVariableAggrandizement", "CoercionItemClass": coerce}]
    return ref


def named(name):
    return {"Type": "Variable", "VariableName": name}


def attachment(ref):
    return {"Value": ref, "WFSerializationType": "WFTextTokenAttachment"}


def text(s, ref=None):
    """Text token. With `ref`, OBJ in `s` marks where the variable sits."""
    value = {"string": s, "attachmentsByRange": {}}
    if ref is not None:
        value["attachmentsByRange"] = {f"{{{s.index(OBJ)}, 1}}": ref}
    return {"Value": value, "WFSerializationType": "WFTextTokenString"}


def var_text(ref):
    return text(OBJ, ref)


def field(key, value):
    return {"WFItemType": 0, "WFKey": text(key), "WFValue": value}


def fields(*items):
    return {"Value": {"WFDictionaryFieldValueItems": list(items)}, "WFSerializationType": "WFDictionaryFieldValue"}


def if_input(ref):
    return {"Type": "Variable", "Variable": attachment(ref)}


def act(ident, **params):
    return {"WFWorkflowActionIdentifier": f"is.workflow.actions.{ident}", "WFWorkflowActionParameters": params}


# ---- actions ----------------------------------------------------------------

U_URL, U_KEY, U_BASE = uid("text.worker-url"), uid("text.key"), uid("replace.base-url")
U_MENU, U_NAME, U_POST = uid("menu.status"), uid("getitemname"), uid("downloadurl")
U_OK, U_IF_OK, U_ERR, U_IF_ERR = uid("value.ok"), uid("if.ok"), uid("value.error"), uid("if.error")

# Labels match the Chrome popup (extension/popup.js LABELS); the status values sent to the Worker don't change.
MENU = [("Send to inbox", "later"), ("Mark as archived", "read"), ("Favorite", "favorite")]


def actions():
    a = [
        # 0, 1: import questions point here; the fallback is editing these two boxes.
        act("gettext", UUID=U_URL, WFTextActionText=text(URL_PLACEHOLDER)),
        act("gettext", UUID=U_KEY, WFTextActionText=text(KEY_PLACEHOLDER)),
        # 2: strip one trailing slash so `<base>/save` never becomes `//save`.
        act("text.replace", UUID=U_BASE, WFInput=var_text(output(U_URL, "Text")),
            WFReplaceTextFind="/$", WFReplaceTextReplace="",
            WFReplaceTextRegularExpression=True, WFReplaceTextCaseSensitive=True),
        act("choosefrommenu", WFControlFlowMode=0, GroupingIdentifier=U_MENU,
            WFMenuPrompt="Save to Satchel", WFMenuItems=[title for title, _ in MENU]),
    ]
    for title, status in MENU:
        a += [
            act("choosefrommenu", WFControlFlowMode=1, GroupingIdentifier=U_MENU, WFMenuItemTitle=title),
            act("gettext", UUID=uid(f"text.status.{status}"), WFTextActionText=text(status)),
            act("setvariable", WFVariableName="status", WFInput=attachment(output(uid(f"text.status.{status}"), "Text"))),
        ]
    a += [
        act("choosefrommenu", WFControlFlowMode=2, GroupingIdentifier=U_MENU, UUID=uid("menu.status.end")),
        act("getitemname", UUID=U_NAME, WFInput=attachment(shortcut_input())),
        act("downloadurl", UUID=U_POST, Advanced=True, ShowHeaders=True,
            WFHTTPMethod="POST", WFHTTPBodyType="JSON",
            WFURL=text(OBJ + "/save", output(U_BASE, "Updated Text")),
            WFHTTPHeaders=fields(field("x-satchel-key", var_text(output(U_KEY, "Text")))),
            WFJSONValues=fields(
                field("url", var_text(shortcut_input(coerce="WFURLContentItem"))),
                field("title", var_text(output(U_NAME, "Name"))),
                field("status", var_text(named("status"))),
            )),
        act("getvalueforkey", UUID=U_OK, WFGetDictionaryValueType="Value", WFDictionaryKey="ok",
            WFInput=attachment(output(U_POST, "Contents of URL"))),
        # `ok` as a number is 1 only for JSON true. Missing, false or a non-JSON body falls to Otherwise.
        act("conditional", WFControlFlowMode=0, GroupingIdentifier=U_IF_OK, WFCondition=4, WFNumberValue=1,
            WFInput=if_input(output(U_OK, "Dictionary Value", coerce="WFNumberContentItem"))),
        act("notification", WFNotificationActionTitle="Satchel", WFNotificationActionBody=text("Saved ✓"),
            WFNotificationActionSound=False),
        act("conditional", WFControlFlowMode=1, GroupingIdentifier=U_IF_OK),
        act("getvalueforkey", UUID=U_ERR, WFGetDictionaryValueType="Value", WFDictionaryKey="error",
            WFInput=attachment(output(U_POST, "Contents of URL"))),
        # 100 = has any value.
        act("conditional", WFControlFlowMode=0, GroupingIdentifier=U_IF_ERR, WFCondition=100,
            WFInput=if_input(output(U_ERR, "Dictionary Value"))),
        act("notification", WFNotificationActionTitle="Satchel: not saved",
            WFNotificationActionBody=var_text(output(U_ERR, "Dictionary Value")), WFNotificationActionSound=True),
        act("conditional", WFControlFlowMode=1, GroupingIdentifier=U_IF_ERR),
        act("notification", WFNotificationActionTitle="Satchel: not saved",
            WFNotificationActionBody=text("unexpected response"), WFNotificationActionSound=True),
        act("conditional", WFControlFlowMode=2, GroupingIdentifier=U_IF_ERR, UUID=uid("if.error.end")),
        act("conditional", WFControlFlowMode=2, GroupingIdentifier=U_IF_OK, UUID=uid("if.ok.end")),
    ]
    return a


def workflow():
    return {
        "WFWorkflowClientVersion": "2607.1.2",
        "WFWorkflowMinimumClientVersion": 900,
        "WFWorkflowMinimumClientVersionString": "900",
        "WFWorkflowIcon": read_icon(),
        "WFWorkflowTypes": ["ActionExtension"],
        "WFWorkflowHasShortcutInputVariables": True,
        "WFWorkflowHasOutputFallback": False,
        "WFWorkflowInputContentItemClasses": [
            "WFURLContentItem", "WFSafariWebPageContentItem", "WFArticleContentItem", "WFStringContentItem",
        ],
        "WFWorkflowOutputContentItemClasses": [],
        "WFWorkflowImportQuestions": [
            {"ActionIndex": 0, "Category": "Parameter", "ParameterKey": "WFTextActionText",
             "Text": "Your Satchel Worker URL, the base only (no /save)", "DefaultValue": ""},
            {"ActionIndex": 1, "Category": "Parameter", "ParameterKey": "WFTextActionText",
             "Text": "Your Satchel key (SATCHEL_KEY)", "DefaultValue": ""},
        ],
        "WFWorkflowActions": actions(),
    }


def main():
    out = pathlib.Path(sys.argv[1]) if len(sys.argv) > 1 else DEFAULT_OUT
    wf = workflow()
    out.write_bytes(plistlib.dumps(wf, fmt=plistlib.FMT_BINARY, sort_keys=True))
    print(f"wrote {out} ({len(wf['WFWorkflowActions'])} actions)")


if __name__ == "__main__":
    main()
