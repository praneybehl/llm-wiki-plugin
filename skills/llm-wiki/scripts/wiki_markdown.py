#!/usr/bin/env python3
"""Shared, dependency-free Markdown helpers for the LLM Wiki tools.

This is deliberately a link extractor, not a renderer. It implements the
CommonMark block/inline rules that determine whether ``[[...]]`` is literal
code: fenced and indented code blocks, common container prefixes, raw HTML
blocks, and backtick code spans scoped to one inline block.
"""

from __future__ import annotations

import re
import sys


# Top-level directories under the wiki root that hold something other than
# curated pages, and so are not part of the corpus any tool walks.
#
# Shared for the same reason WIKILINK_RE is: five scripts each carried their own
# copy and they had already diverged — only wiki_search.py knew about
# `.wiki-cache`. A page that one tool indexes and another ignores is a silent
# inconsistency, and the failure surfaces far from the cause: an uncurated file
# dropped into wiki/ gets embedded into the *tracked* vector index by the next
# hybrid query, while lint and staleness never see it.
#
#   indexes/     navigational shards — they describe the wiki, they are not it
#   graph/       compiled graph artifacts
#   raw/         unprocessed sources, when a project keeps them inside the wiki
#   Clippings/   saved web material: scratch input for ingest, not a page
#   .wiki-cache/ derived retrieval artifacts
SKIP_TOP_LEVEL_DIRS = frozenset({"indexes", "graph", "raw", "Clippings", ".wiki-cache"})

WIKILINK_RE = re.compile(r"\[\[([^\]|\\\r\n]+)(?:\\?\|[^\]\r\n]+)?\]\]")
FENCE_OPEN_RE = re.compile(r"^ {0,3}(`{3,}|~{3,})([^\r\n]*)$")
LIST_MARKER_RE = re.compile(r"^( {0,3})([-+*]|\d{1,9}[.)])(?:([ \t]+)(.*)|)$")
ATX_HEADING_RE = re.compile(r"^ {0,3}#{1,6}(?:[ \t]+|$)")
THEMATIC_BREAK_RE = re.compile(r"^ {0,3}(?:\*[ \t]*){3,}$|^ {0,3}(?:-[ \t]*){3,}$|^ {0,3}(?:_[ \t]*){3,}$")
SETEXT_HEADING_RE = re.compile(r"^ {0,3}(?:=+|-+)[ \t]*$")
BACKTICK_RUN_RE = re.compile(r"`+")
HTML_PRE_BLOCK_RE = re.compile(r"^ {0,3}<(pre|script|style|textarea)(?:[ \t>]|$)", re.IGNORECASE)
HTML_BLOCK_TAGS = (
    "address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|"
    "dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|"
    "frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|"
    "nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|"
    "tfoot|th|thead|title|tr|track|ul"
)
HTML_BLOCK_TAG_RE = re.compile(
    rf"^ {{0,3}}</?(?:{HTML_BLOCK_TAGS})(?:[ \t]|/?>|$)",
    re.IGNORECASE,
)
HTML_ATTRIBUTE_NAME = r"[A-Za-z_:][A-Za-z0-9_.:-]*"
HTML_ATTRIBUTE_VALUE = r'''(?:[^ \t\r\n"'=<>`]+|'[^']*'|"[^"]*")'''
HTML_ATTRIBUTE = rf"(?:[ \t]+{HTML_ATTRIBUTE_NAME}(?:[ \t]*=[ \t]*{HTML_ATTRIBUTE_VALUE})?)"
HTML_COMPLETE_TAG_RE = re.compile(
    rf"^ {{0,3}}(?:"
    rf"<[A-Za-z][A-Za-z0-9-]*{HTML_ATTRIBUTE}*[ \t]*/?>|"
    rf"</[A-Za-z][A-Za-z0-9-]*[ \t]*>"
    rf")[ \t]*$"
)
HTML_COMMENT_RE = re.compile(r"<!--.*?-->", re.DOTALL)


def configure_utf8_streams() -> None:
    """Keep Unicode wiki titles and diagnostics printable on Windows CLIs."""
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8")


def _blank_preserving_newlines(text: str) -> str:
    return "".join(char if char in "\r\n" else " " for char in text)


def _is_escaped(text: str, position: int) -> bool:
    backslashes = 0
    position -= 1
    while position >= 0 and text[position] == "\\":
        backslashes += 1
        position -= 1
    return backslashes % 2 == 1


def _indent_columns(text: str) -> tuple[int, int]:
    """Return visual indentation columns and the first non-indent offset."""
    columns = 0
    offset = 0
    while offset < len(text) and text[offset] in " \t":
        if text[offset] == "\t":
            columns += 4 - (columns % 4)
        else:
            columns += 1
        offset += 1
    return columns, offset


def _visual_columns(text: str) -> int:
    """Return the display columns occupied by a container prefix."""
    columns = 0
    for character in text:
        columns += 4 - (columns % 4) if character == "\t" else 1
    return columns


def _strip_columns(text: str, wanted: int) -> tuple[str, bool]:
    """Strip at least ``wanted`` indentation columns without splitting tabs."""
    columns = 0
    offset = 0
    while offset < len(text) and text[offset] in " \t" and columns < wanted:
        if text[offset] == "\t":
            columns += 4 - (columns % 4)
        else:
            columns += 1
        offset += 1
    return text[offset:], columns >= wanted


def _strip_blockquote_prefix(text: str) -> tuple[int, str]:
    """Strip repeated blockquote markers and return (depth, content)."""
    depth = 0
    rest = text
    while True:
        match = re.match(r"^ {0,3}>[ \t]?", rest)
        if not match:
            return depth, rest
        depth += 1
        rest = rest[match.end():]


def _list_marker_can_interrupt(marker: re.Match[str], paragraph_active: bool) -> bool:
    """Apply CommonMark's special rules for a list interrupting a paragraph."""
    if not paragraph_active:
        return True
    item_content = marker.group(4) or ""
    if not item_content.strip():
        return False
    token = marker.group(2)
    return not token[0].isdigit() or int(token[:-1]) == 1


def _list_item(marker: re.Match[str]) -> tuple[int, str]:
    """Return the continuation indent and content introduced by a list marker."""
    prefix_without_padding = marker.group(1) + marker.group(2)
    base_columns = _visual_columns(prefix_without_padding)
    whitespace = marker.group(3)
    item_content = marker.group(4) or ""
    if whitespace is None:  # A marker alone is a valid empty list item.
        return base_columns + 1, item_content

    full_prefix = marker.group(1) + marker.group(2) + whitespace
    padding_columns = _visual_columns(full_prefix) - base_columns
    if padding_columns <= 4:
        return _visual_columns(full_prefix), item_content

    # CommonMark treats 5+ spaces after a marker as one container padding
    # space plus indented content.
    remaining_padding, _ = _strip_columns(whitespace, 1)
    return base_columns + 1, remaining_padding + item_content


def _logical_content(
    raw: str,
    containers: list[tuple[str, int]],
    paragraph_key: tuple[tuple[str, int], ...] | None,
    allow_new_containers: bool = True,
) -> tuple[tuple[tuple[str, int], ...], str, bool]:
    """Return the active container signature and its relative line content.

    Container order is significant: ``- >`` is a list containing a quote,
    while ``> -`` is a quote containing a list. Keeping the complete stack is
    also what lets an unclosed fence end exactly when a nested item ends.
    """
    if not raw.strip():
        return tuple(containers), "", False

    content = raw
    matched = 0
    for kind, width in containers:
        if kind == "quote":
            marker = re.match(r"^ {0,3}>[ \t]?", content)
            if not marker:
                break
            content = content[marker.end():]
        else:
            content, belongs = _strip_columns(content, width)
            if not belongs:
                break
        matched += 1
    if matched != len(containers):
        del containers[matched:]

    if not allow_new_containers:
        return tuple(containers), content, False

    starts_list = False
    while True:
        quote = re.match(r"^ {0,3}>[ \t]?", content)
        if quote:
            containers.append(("quote", 0))
            content = content[quote.end():]
            continue

        list_marker = LIST_MARKER_RE.match(content)
        paragraph_active = paragraph_key == tuple(containers)
        if (list_marker
                and not THEMATIC_BREAK_RE.match(content)
                and _list_marker_can_interrupt(list_marker, paragraph_active)):
            indent, content = _list_item(list_marker)
            containers.append(("list", indent))
            starts_list = True
            continue
        break

    return tuple(containers), content, starts_list


def _html_block_opener(content: str, paragraph_active: bool) -> tuple[str, bool] | None:
    """Return (termination mode, already closed) for a CommonMark HTML block."""
    if re.match(r"^ {0,3}<!--", content):
        return "comment", "-->" in content
    if re.match(r"^ {0,3}<\?", content):
        return "processing", "?>" in content
    if re.match(r"^ {0,3}<![A-Z]", content):
        return "declaration", ">" in content
    if re.match(r"^ {0,3}<!\[CDATA\[", content):
        return "cdata", "]]>" in content

    pre_match = HTML_PRE_BLOCK_RE.match(content)
    if pre_match:
        tag = pre_match.group(1).lower()
        return f"tag:{tag}", bool(re.search(rf"</{tag}[ \t]*>", content, re.IGNORECASE))
    if HTML_BLOCK_TAG_RE.match(content):
        return "blank", False
    if not paragraph_active and HTML_COMPLETE_TAG_RE.match(content):
        return "blank", False
    return None


def _html_block_closed(mode: str, content: str) -> bool:
    if mode == "comment":
        return "-->" in content
    if mode == "processing":
        return "?>" in content
    if mode == "declaration":
        return ">" in content
    if mode == "cdata":
        return "]]>" in content
    if mode.startswith("tag:"):
        tag = mode.partition(":")[2]
        return bool(re.search(rf"</{tag}[ \t]*>", content, re.IGNORECASE))
    return False


def strip_block_code(text: str) -> str:
    """Mask fenced, indented, and raw HTML blocks.

    Fences are container-aware for blockquotes and ordinary list items. An
    unclosed fence ends at the end of its container (or the document at root).
    """
    output: list[str] = []
    lines = text.splitlines(keepends=True)
    containers: list[tuple[str, int]] = []
    fence: tuple[str, int, tuple[tuple[str, int], ...]] | None = None
    indented: tuple[tuple[str, int], ...] | None = None
    html_block: tuple[str, tuple[tuple[str, int], ...]] | None = None
    paragraph_key: tuple[tuple[str, int], ...] | None = None

    for line in lines:
        ending_length = len(line) - len(line.rstrip("\r\n"))
        raw = line[:-ending_length] if ending_length else line
        literal_block_active = fence is not None or html_block is not None
        key, content, starts_list = _logical_content(
            raw,
            containers,
            paragraph_key,
            allow_new_containers=not literal_block_active,
        )

        if fence is not None:
            fence_char, fence_length, fence_key = fence
            if key != fence_key and content.strip():
                fence = None
                key, content, starts_list = _logical_content(raw, containers, paragraph_key)
            else:
                closing = re.fullmatch(
                    rf" {{0,3}}{re.escape(fence_char)}{{{fence_length},}}[ \t]*",
                    content,
                )
                output.append(_blank_preserving_newlines(line))
                if closing:
                    fence = None
                continue

        if indented is not None:
            if key == indented and (not content.strip() or _indent_columns(content)[0] >= 4):
                output.append(_blank_preserving_newlines(line))
                continue
            indented = None

        if html_block is not None:
            mode, html_key = html_block
            if mode == "blank" and not content.strip():
                html_block = None
                output.append(line)
                paragraph_key = None
                continue
            if key != html_key and content.strip():
                html_block = None
                key, content, starts_list = _logical_content(raw, containers, paragraph_key)
            else:
                output.append(_blank_preserving_newlines(line))
                if _html_block_closed(mode, content):
                    html_block = None
                continue

        if not content.strip():
            output.append(line)
            paragraph_key = None
            continue

        fence_match = FENCE_OPEN_RE.match(content)
        if fence_match:
            opening = fence_match.group(1)
            info = fence_match.group(2)
            if opening[0] != "`" or "`" not in info:
                fence = (opening[0], len(opening), key)
                output.append(_blank_preserving_newlines(line))
                paragraph_key = None
                continue

        html_open = _html_block_opener(content, paragraph_key == key)
        if html_open:
            mode, already_closed = html_open
            output.append(_blank_preserving_newlines(line))
            if mode == "blank" or not already_closed:
                html_block = (mode, key)
            paragraph_key = None
            continue

        indent, _ = _indent_columns(content)
        if indent >= 4 and paragraph_key != key:
            indented = key
            output.append(_blank_preserving_newlines(line))
            continue

        output.append(line)
        if (starts_list or ATX_HEADING_RE.match(content)
                or THEMATIC_BREAK_RE.match(content) or SETEXT_HEADING_RE.match(content)):
            paragraph_key = None if (ATX_HEADING_RE.match(content)
                                     or THEMATIC_BREAK_RE.match(content)
                                     or SETEXT_HEADING_RE.match(content)) else key
        else:
            paragraph_key = key

    return "".join(output)


def _strip_inline_code_block(text: str) -> str:
    runs = list(BACKTICK_RUN_RE.finditer(text))
    spans: list[tuple[int, int]] = []
    index = 0
    while index < len(runs):
        opener = runs[index]
        if _is_escaped(text, opener.start()):
            index += 1
            continue
        for closer_index in range(index + 1, len(runs)):
            closer = runs[closer_index]
            if len(closer.group(0)) == len(opener.group(0)):
                spans.append((opener.start(), closer.end()))
                index = closer_index + 1
                break
        else:
            index += 1

    if not spans:
        return text
    output: list[str] = []
    cursor = 0
    for start, end in spans:
        output.append(text[cursor:start])
        output.append(_blank_preserving_newlines(text[start:end]))
        cursor = end
    output.append(text[cursor:])
    return "".join(output)


def strip_inline_code(text: str) -> str:
    """Mask code spans without matching delimiters across block boundaries."""
    output: list[str] = []
    block: list[str] = []
    block_key: tuple[int, bool] | None = None

    def flush() -> None:
        if block:
            output.append(_strip_inline_code_block("".join(block)))
            block.clear()

    for line in text.splitlines(keepends=True):
        ending_length = len(line) - len(line.rstrip("\r\n"))
        raw = line[:-ending_length] if ending_length else line
        if not raw.strip():
            flush()
            output.append(line)
            block_key = None
            continue

        quote_depth, content = _strip_blockquote_prefix(raw)
        list_marker = LIST_MARKER_RE.match(content)
        starts_list = bool(
            list_marker
            and not THEMATIC_BREAK_RE.match(content)
            and _list_marker_can_interrupt(list_marker, bool(block))
        )
        is_setext = bool(SETEXT_HEADING_RE.match(content))
        is_new_block = bool(
            ATX_HEADING_RE.match(content)
            or THEMATIC_BREAK_RE.match(content)
            or is_setext
            or starts_list
        )
        key = (quote_depth, is_new_block)
        if block and (quote_depth != block_key[0] or is_new_block):
            flush()
        block.append(line)
        block_key = key
        if ATX_HEADING_RE.match(content) or THEMATIC_BREAK_RE.match(content) or is_setext:
            flush()
            block_key = None
    flush()
    return "".join(output)


def extract_wikilinks(body: str) -> list[str]:
    """Return cross-page wikilink targets outside Markdown code constructs."""
    stripped = strip_block_code(body)
    stripped = HTML_COMMENT_RE.sub(
        lambda match: _blank_preserving_newlines(match.group(0)),
        stripped,
    )
    stripped = strip_inline_code(stripped)
    links: list[str] = []
    for match in WIKILINK_RE.finditer(stripped):
        if _is_escaped(stripped, match.start()):
            continue
        target = match.group(1).strip()
        if target.startswith("#"):
            continue
        target = target.split("#", 1)[0].strip()
        if target:
            links.append(target)
    return links
