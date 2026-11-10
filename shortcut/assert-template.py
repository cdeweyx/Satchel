#!/usr/bin/env python3
"""Structural assertion on the unsigned Satchel Shortcut template (D-7).

Usage: python3 -I shortcut/assert-template.py [TEMPLATE]

TEMPLATE defaults to $SATCHEL_TEMPLATE, else shortcut/Satchel.unsigned.shortcut
next to this script. Exits 0 and prints one `ok` line when the template holds
the shape below; else prints one line per failure and exits 1.

The expected shape is written by hand from shortcut/README.md's action list and
build-shortcut.py. It's never read back from the template, so a generator change
that drifts from the README fails here until both are updated on purpose.
"""

import os
import pathlib
import plistlib
import re
import sys

HERE = pathlib.Path(__file__).resolve().parent
DEFAULT_TEMPLATE = HERE / "Satchel.unsigned.shortcut"

A = "is.workflow.actions."

# (identifier, WFControlFlowMode or None), index for index with the README list.
EXPECTED_ACTIONS = [
    (A + "gettext", None),              # 0 Text: WORKER_URL_PLACEHOLDER
    (A + "gettext", None),              # 1 Text: KEY_PLACEHOLDER
    (A + "text.replace", None),         # 2 Replace Text /$
    (A + "getitemname", None),          # 3 Get Name
    (A + "downloadurl", None),          # 4 Get Contents of URL
    (A + "getvalueforkey", None),       # 5 Get Dictionary Value ok
    (A + "conditional", 0),             # 6 If ok
    (A + "notification", None),         # 7 Saved ✓
    (A + "conditional", 1),             # 8 Otherwise
    (A + "getvalueforkey", None),       # 9 Get Dictionary Value error
    (A + "conditional", 0),             # 10 If error has any value
    (A + "notification", None),         # 11 not saved / error
    (A + "conditional", 1),             # 12 Otherwise
    (A + "notification", None),         # 13 not saved / unexpected response
    (A + "conditional", 2),             # 14 End If (inner)
    (A + "conditional", 2),             # 15 End If (outer)
]

POST = 4  # index of Get Contents of URL

INPUT_CLASSES = {"WFURLContentItem", "WFSafariWebPageContentItem", "WFArticleContentItem", "WFStringContentItem"}
ALLOWED_PLACEHOLDERS = {"WORKER_URL_PLACEHOLDER", "KEY_PLACEHOLDER"}

# Anything that reads like a placeholder token. Allowed ones are filtered out after.
PLACEHOLDER_RE = re.compile(r"[A-Za-z0-9_]*placeholder[A-Za-z0-9_]*|\{\{[^}]*\}\}|\bYOUR_[A-Z0-9_]+|\bCHANGE_?ME\b|\bTODO\b", re.I)
SECRET_RES = [
    ("an Anthropic key (sk-ant-)", re.compile(r"sk-ant-")),
    ("a 32+ char hex run", re.compile(r"[0-9a-fA-F]{32,}")),
    ("a workers.dev URL", re.compile(r"workers\.dev", re.I)),
]


class Fail(Exception):
    pass


def strings(node):
    """Every string in the plist, keys included."""
    if isinstance(node, str):
        yield node
    elif isinstance(node, dict):
        for k, v in node.items():
            yield from strings(k)
            yield from strings(v)
    elif isinstance(node, list):
        for v in node:
            yield from strings(v)


def token(value):
    """The plain string of a WFTextTokenString, or None."""
    if isinstance(value, dict) and value.get("WFSerializationType") == "WFTextTokenString":
        return value.get("Value", {}).get("string")
    return None


def token_refs(value):
    if isinstance(value, dict) and value.get("WFSerializationType") == "WFTextTokenString":
        return list(value.get("Value", {}).get("attachmentsByRange", {}).values())
    return []


def scan_secrets(raw, wf):
    # Walk decoded strings (catches UTF-16 ones) and the raw bytes (catches anything else).
    haystacks = list(strings(wf)) + [raw.decode("latin-1")]
    for what, rx in SECRET_RES:
        for s in haystacks:
            if rx.search(s):
                raise Fail(f"template contains {what}; it must hold placeholders only")


def check(wf):
    errors = []

    def need(cond, msg):
        if not cond:
            errors.append(msg)
        return cond

    actions = wf.get("WFWorkflowActions")
    if not need(isinstance(actions, list), "WFWorkflowActions missing"):
        return errors
    params = [a.get("WFWorkflowActionParameters", {}) for a in actions]

    # 1. Action identifiers in order.
    got = [(a.get("WFWorkflowActionIdentifier"), p.get("WFControlFlowMode")) for a, p in zip(actions, params)]
    if got != EXPECTED_ACTIONS:
        first = next((i for i, (g, e) in enumerate(zip(got, EXPECTED_ACTIONS)) if g != e), min(len(got), len(EXPECTED_ACTIONS)))
        g = got[first] if first < len(got) else "nothing"
        e = EXPECTED_ACTIONS[first] if first < len(EXPECTED_ACTIONS) else "nothing"
        errors.append(f"actions differ at [{first}]: expected {e}, got {g} ({len(got)} actions, expected {len(EXPECTED_ACTIONS)})")
        return errors  # index-based checks below would only add noise

    # 2. The two Text actions hold the placeholders.
    need(token(params[0].get("WFTextActionText")) == "WORKER_URL_PLACEHOLDER", "[0] Text isn't WORKER_URL_PLACEHOLDER")
    need(token(params[1].get("WFTextActionText")) == "KEY_PLACEHOLDER", "[1] Text isn't KEY_PLACEHOLDER")
    key_uuid = params[1].get("UUID")

    # 3. Exactly one header row, x-satchel-key = the key Text.
    headers = params[POST].get("WFHTTPHeaders", {}).get("Value", {}).get("WFDictionaryFieldValueItems")
    if need(isinstance(headers, list) and len(headers) == 1,
            f"Get Contents of URL needs exactly one header row, found {len(headers) if isinstance(headers, list) else 'none'}"):
        row = headers[0]
        need(token(row.get("WFKey")) == "x-satchel-key", f"header row key is {token(row.get('WFKey'))!r}, expected 'x-satchel-key'")
        refs = token_refs(row.get("WFValue"))
        need(len(refs) == 1 and refs[0].get("OutputUUID") == key_uuid, "x-satchel-key value isn't the key Text output")
    # Every phone save goes to Inbox (SAT-59): the body's `status` is the plain text `later`, no variable.
    body = params[POST].get("WFJSONValues", {}).get("Value", {}).get("WFDictionaryFieldValueItems") or []
    status = [row for row in body if token(row.get("WFKey")) == "status"]
    if need(len(status) == 1, f"JSON body needs exactly one `status` field, found {len(status)}"):
        need(token(status[0].get("WFValue")) == "later" and not token_refs(status[0].get("WFValue")),
             f"JSON body `status` is {token(status[0].get('WFValue'))!r}, expected the plain text 'later'")
    need(params[POST].get("WFHTTPMethod") == "POST", "Get Contents of URL method isn't POST")
    need(params[POST].get("Advanced") is True and params[POST].get("ShowHeaders") is True, "Advanced and ShowHeaders must both be true")

    # 4. Key import question defaults to "".
    questions = wf.get("WFWorkflowImportQuestions", [])
    key_q = [q for q in questions if q.get("ActionIndex") == 1]
    if need(len(key_q) == 1, f"expected one import question on the key Text [1], found {len(key_q)}"):
        need(key_q[0].get("ParameterKey") == "WFTextActionText", "key import question doesn't target WFTextActionText")
        need(key_q[0].get("DefaultValue") == "", f"key import question default is {key_q[0].get('DefaultValue')!r}, expected ''")
    need(any(q.get("ActionIndex") == 0 for q in questions), "no import question on the Worker URL Text [0]")

    # 5. The ok branch: If on Dictionary Value `ok`, Saved ✓ inside, "Satchel: not saved" in Otherwise.
    ok_get = [i for i, p in enumerate(params)
              if actions[i]["WFWorkflowActionIdentifier"] == A + "getvalueforkey" and p.get("WFDictionaryKey") == "ok"]
    if need(len(ok_get) == 1, f"expected one Get Dictionary Value `ok`, found {len(ok_get)}"):
        ok_uuid = params[ok_get[0]].get("UUID")
        ifs = [i for i, p in enumerate(params)
               if actions[i]["WFWorkflowActionIdentifier"] == A + "conditional" and p.get("WFControlFlowMode") == 0
               and p.get("WFInput", {}).get("Variable", {}).get("Value", {}).get("OutputUUID") == ok_uuid]
        if need(len(ifs) == 1, "no If on Dictionary Value `ok`"):
            group = params[ifs[0]].get("GroupingIdentifier")
            marks = {p.get("WFControlFlowMode"): i for i, p in enumerate(params)
                     if actions[i]["WFWorkflowActionIdentifier"] == A + "conditional" and p.get("GroupingIdentifier") == group}
            if need(set(marks) == {0, 1, 2}, "the `ok` If is missing its Otherwise or End If"):
                then_part = range(marks[0] + 1, marks[1])
                else_part = range(marks[1] + 1, marks[2])

                def notes(span):
                    return [params[i] for i in span if actions[i]["WFWorkflowActionIdentifier"] == A + "notification"]

                need(any(token(n.get("WFNotificationActionBody")) == "Saved ✓" for n in notes(then_part)),
                     "no Saved ✓ notification inside the `ok` If")
                need(not any(token(n.get("WFNotificationActionBody")) == "Saved ✓" for n in notes(else_part)),
                     "Saved ✓ notification in the `ok` Otherwise")
                need(any(n.get("WFNotificationActionTitle") == "Satchel: not saved" for n in notes(else_part)),
                     'no "Satchel: not saved" notification in the `ok` Otherwise')

    # 6. Share-sheet shortcut for the four input classes.
    need(wf.get("WFWorkflowTypes") == ["ActionExtension"], f"WFWorkflowTypes is {wf.get('WFWorkflowTypes')!r}, expected ['ActionExtension']")
    classes = wf.get("WFWorkflowInputContentItemClasses", [])
    need(len(classes) == len(INPUT_CLASSES) and set(classes) == INPUT_CLASSES,
         f"input classes are {classes!r}, expected {sorted(INPUT_CLASSES)}")

    # 7. No placeholder but the two allowed, each exactly once.
    found = [m.group(0) for s in strings(wf) for m in PLACEHOLDER_RE.finditer(s)]
    stray = sorted({f for f in found if f not in ALLOWED_PLACEHOLDERS})
    need(not stray, f"unexpected placeholder(s): {', '.join(stray)}")
    for p in sorted(ALLOWED_PLACEHOLDERS):
        need(found.count(p) == 1, f"{p} appears {found.count(p)} times, expected once")

    return errors


def main():
    path = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else os.environ.get("SATCHEL_TEMPLATE") or DEFAULT_TEMPLATE)
    try:
        raw = path.read_bytes()
        wf = plistlib.loads(raw)
        scan_secrets(raw, wf)
        errors = check(wf)
    except Fail as e:
        errors = [str(e)]
    except (OSError, plistlib.InvalidFileException, ValueError) as e:
        errors = [f"can't read {path}: {e}"]
    if errors:
        for e in errors:
            print(f"assert-template: FAIL {path.name}: {e}", file=sys.stderr)
        sys.exit(1)
    print(f"assert-template: ok {path.name} ({len(EXPECTED_ACTIONS)} actions)")


if __name__ == "__main__":
    main()
