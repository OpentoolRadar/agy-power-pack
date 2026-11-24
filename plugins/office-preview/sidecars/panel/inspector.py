#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Office document metadata, comment, speaker-note, worksheet parser and PDF page renderer.

Highlights:
- Parses OOXML (.pptx / .docx / .xlsx) and .csv/.tsv using Python's standard library only (zero pip dependencies)
- Uses PyMuPDF (fitz) when installed for high-DPI page rendering, PDF outlines, and PDF annotations
- Emits UTF-8 JSON to stdout
"""

import argparse
import csv
import json
import os
import posixpath
import re
import sys
import zipfile
import xml.etree.ElementTree as ET
from pathlib import Path

try:
    import fitz  # PyMuPDF
    HAS_FITZ = True
except Exception:
    fitz = None
    HAS_FITZ = False


def local_name(tag: str) -> str:
    if not isinstance(tag, str):
        return ""
    if "}" in tag:
        return tag.rsplit("}", 1)[1]
    return tag


def get_attr(elem, name: str, default: str = "") -> str:
    if elem is None:
        return default
    if name in elem.attrib:
        return elem.attrib[name]
    suffix = "}" + name
    for k, v in elem.attrib.items():
        if k.endswith(suffix) or k == name:
            return v
    return default


def norm_space(text: str) -> str:
    return re.sub(r"\s+", " ", (text or "")).strip()


def norm_match(text: str) -> str:
    return re.sub(r"\s+", "", (text or "")).lower()


def resolve_rel_target(base_part: str, target: str) -> str:
    if not target:
        return ""
    if target.startswith("/"):
        return target.lstrip("/")
    base_dir = posixpath.dirname(base_part)
    joined = posixpath.normpath(posixpath.join(base_dir, target))
    return joined.lstrip("/")


def parse_rels(zf: zipfile.ZipFile, part_path: str) -> dict:
    """Parse an OOXML part's .rels file into {rId: {target, type}}."""
    dirname = posixpath.dirname(part_path)
    basename = posixpath.basename(part_path)
    rels_path = posixpath.join(dirname, "_rels", basename + ".rels") if dirname else f"_rels/{basename}.rels"
    rels = {}
    if rels_path not in zf.namelist():
        return rels
    try:
        root = ET.fromstring(zf.read(rels_path))
        for rel in root:
            if local_name(rel.tag) != "Relationship":
                continue
            rid = get_attr(rel, "Id")
            target = get_attr(rel, "Target")
            rtype = get_attr(rel, "Type")
            mode = get_attr(rel, "TargetMode")
            if rid and mode.lower() != "external":
                rels[rid] = {
                    "target": resolve_rel_target(part_path, target),
                    "type": rtype,
                }
    except Exception:
        pass
    return rels


def parse_core_properties(zf: zipfile.ZipFile) -> dict:
    info = {"title": "", "author": "", "subject": "", "modified": ""}
    if "docProps/core.xml" not in zf.namelist():
        return info
    try:
        root = ET.fromstring(zf.read("docProps/core.xml"))
        for child in root:
            ln = local_name(child.tag)
            txt = (child.text or "").strip()
            if ln == "title":
                info["title"] = txt
            elif ln == "creator":
                info["author"] = txt
            elif ln == "subject":
                info["subject"] = txt
            elif ln == "modified":
                info["modified"] = txt
    except Exception:
        pass
    return info


def extract_drawingml_paragraphs(root) -> list:
    """Extract paragraph strings from DrawingML / PresentationML XML."""
    paragraphs = []
    for p in root.iter():
        if local_name(p.tag) != "p":
            continue
        parts = []
        for child in p.iter():
            ln = local_name(child.tag)
            if ln == "t" and child.text:
                parts.append(child.text)
            elif ln == "br":
                parts.append("\n")
            elif ln == "tab":
                parts.append("\t")
        line = "".join(parts).strip()
        if line:
            paragraphs.append(line)
    return paragraphs


def extract_word_element_text(elem) -> str:
    """Extract paragraph text from a WordprocessingML element."""
    paragraphs = []
    p_nodes = [n for n in elem.iter() if local_name(n.tag) == "p"]
    if not p_nodes:
        parts = []
        for n in elem.iter():
            ln = local_name(n.tag)
            if ln in ("t", "delText") and n.text:
                parts.append(n.text)
            elif ln in ("br", "cr"):
                parts.append("\n")
            elif ln == "tab":
                parts.append("\t")
        return "".join(parts).strip()

    for p in p_nodes:
        parts = []
        for n in p.iter():
            ln = local_name(n.tag)
            if ln in ("t", "delText") and n.text:
                parts.append(n.text)
            elif ln in ("br", "cr"):
                parts.append("\n")
            elif ln == "tab":
                parts.append("\t")
        line = "".join(parts).strip()
        if line:
            paragraphs.append(line)
    return "\n".join(paragraphs).strip()


# ---------------------------------------------------------------------------
# PPTX Parser (slide order, titles, speaker notes, legacy & M365 comments)
# ---------------------------------------------------------------------------

def extract_pptx_slide_title(slide_root) -> str:
    # Prefer title / ctrTitle placeholders
    for sp in slide_root.iter():
        if local_name(sp.tag) != "sp":
            continue
        is_title = False
        for node in sp.iter():
            if local_name(node.tag) == "ph":
                ph_type = get_attr(node, "type").lower()
                if ph_type in ("title", "ctrtitle", "subtitle"):
                    is_title = True
                    break
        if is_title:
            paras = extract_drawingml_paragraphs(sp)
            if paras:
                return norm_space(" ".join(paras))[:120]
    # Fallback: first non-numeric text paragraph
    for para in extract_drawingml_paragraphs(slide_root):
        cleaned = norm_space(para)
        if cleaned and not cleaned.isdigit():
            return cleaned[:120]
    return ""


def parse_pptx(file_path: str) -> dict:
    result = {
        "title": "",
        "author": "",
        "slideCount": 0,
        "slides": [],
        "outline": [],
        "comments": [],
        "notes": [],
        "revisions": [],
        "sheets": [],
    }
    with zipfile.ZipFile(file_path, "r") as zf:
        names = set(zf.namelist())
        core = parse_core_properties(zf)
        result["title"] = core["title"]
        result["author"] = core["author"]

        # 1) Legacy comment authors
        legacy_authors = {}
        if "ppt/commentAuthors.xml" in names:
            try:
                aroot = ET.fromstring(zf.read("ppt/commentAuthors.xml"))
                for cm_author in aroot.iter():
                    if local_name(cm_author.tag) == "cmAuthor":
                        aid = get_attr(cm_author, "id")
                        legacy_authors[aid] = {
                            "name": get_attr(cm_author, "name") or f"Author {aid}",
                            "initials": get_attr(cm_author, "initials"),
                        }
            except Exception:
                pass

        # 2) Microsoft 365 modern comment authors
        modern_authors = {}
        for candidate in ("ppt/authors.xml", "ppt/comments/authors.xml"):
            if candidate in names:
                try:
                    aroot = ET.fromstring(zf.read(candidate))
                    for author in aroot.iter():
                        if local_name(author.tag) == "author":
                            aid = get_attr(author, "id")
                            modern_authors[aid] = {
                                "name": get_attr(author, "name") or "Reviewer",
                                "initials": get_attr(author, "initials"),
                            }
                except Exception:
                    pass

        # 3) Resolve slide order from presentation.xml
        slide_parts = []
        if "ppt/presentation.xml" in names:
            pres_rels = parse_rels(zf, "ppt/presentation.xml")
            try:
                proot = ET.fromstring(zf.read("ppt/presentation.xml"))
                for node in proot.iter():
                    if local_name(node.tag) == "sldId":
                        # sldId carries both numeric 'id' and relationship 'r:id'; match namespaced '}id'
                        rel_id = ""
                        for k, v in node.attrib.items():
                            if k.endswith("}id"):
                                rel_id = v
                                break
                        if rel_id and rel_id in pres_rels:
                            slide_parts.append(pres_rels[rel_id]["target"])
            except Exception:
                pass

        if not slide_parts:
            # Fallback: sort by slide index
            def slide_num(p):
                m = re.search(r"slide(\d+)\.xml$", p)
                return int(m.group(1)) if m else 99999
            slide_parts = sorted(
                [n for n in names if re.match(r"^ppt/slides/slide\d+\.xml$", n)],
                key=slide_num,
            )

        result["slideCount"] = len(slide_parts)
        comment_seq = 0

        for idx, slide_part in enumerate(slide_parts, start=1):
            slide_title = f"Slide {idx}"
            if slide_part in names:
                try:
                    sroot = ET.fromstring(zf.read(slide_part))
                    extracted_title = extract_pptx_slide_title(sroot)
                    if extracted_title:
                        slide_title = extracted_title
                except Exception:
                    pass

            result["slides"].append({"page": idx, "title": slide_title})
            result["outline"].append({"level": 1, "title": f"{idx}. {slide_title}", "page": idx})

            srels = parse_rels(zf, slide_part)
            for rel in srels.values():
                target = rel["target"]
                rtype = rel["type"].lower()
                if target not in names:
                    continue

                # Speaker notes
                if "notesslide" in rtype or re.search(r"notesSlides/notesSlide\d+\.xml$", target):
                    try:
                        nroot = ET.fromstring(zf.read(target))
                        # Extract body placeholders only (skip slide number / header / footer)
                        note_chunks = []
                        for sp in nroot.iter():
                            if local_name(sp.tag) != "sp":
                                continue
                            ph_type = ""
                            for node in sp.iter():
                                if local_name(node.tag) == "ph":
                                    ph_type = get_attr(node, "type").lower()
                                    break
                            if ph_type in ("sldnum", "sldimg", "hdr", "ftr", "dt"):
                                continue
                            paras = extract_drawingml_paragraphs(sp)
                            if paras:
                                note_chunks.extend(paras)
                        note_text = "\n".join(note_chunks).strip()
                        if note_text:
                            result["notes"].append({
                                "id": f"slide-note-{idx}",
                                "kind": "speaker_note",
                                "page": idx,
                                "label": f"Slide {idx} - Speaker Notes",
                                "slideTitle": slide_title,
                                "text": note_text,
                            })
                    except Exception:
                        pass

                # Legacy and Microsoft 365 threaded comments
                elif "comments" in rtype or "/comments/" in target:
                    try:
                        croot = ET.fromstring(zf.read(target))
                        root_ln = local_name(croot.tag)
                        # Legacy format: <p:cmLst><p:cm authorId="..." dt="..." idx="...">
                        found_any = False
                        for cm in croot.iter():
                            ln = local_name(cm.tag)
                            if ln == "cm":
                                found_any = True
                                aid = get_attr(cm, "authorId")
                                ainfo = legacy_authors.get(aid, {"name": f"Reviewer {aid}" if aid else "Reviewer", "initials": ""})
                                dt = get_attr(cm, "dt")
                                text_parts = []
                                for ch in cm:
                                    if local_name(ch.tag) == "text" and ch.text:
                                        text_parts.append(ch.text)
                                ctext = "\n".join(text_parts).strip()
                                if not ctext:
                                    ctext = "\n".join(extract_drawingml_paragraphs(cm)).strip()
                                if ctext:
                                    comment_seq += 1
                                    result["comments"].append({
                                        "id": f"ppt-c-{comment_seq}",
                                        "author": ainfo["name"],
                                        "initials": ainfo["initials"],
                                        "date": dt,
                                        "text": ctext,
                                        "page": idx,
                                        "location": f"Slide {idx} - {slide_title}",
                                        "anchorText": "",
                                        "resolved": False,
                                        "replies": [],
                                    })
                        # Modern threaded format: <p188:cmLst><p188:cm id="..." authorId="..." created="..." status="resolved">
                        if not found_any and root_ln in ("cmLst", "commentList"):
                            for cm in croot:
                                if local_name(cm.tag) not in ("cm", "comment"):
                                    continue
                                aid = get_attr(cm, "authorId")
                                ainfo = modern_authors.get(aid, {"name": "Reviewer", "initials": ""})
                                dt = get_attr(cm, "created") or get_attr(cm, "dt")
                                status = get_attr(cm, "status").lower()
                                resolved = status in ("resolved", "closed", "done")
                                tx_body = None
                                replies = []
                                for ch in cm:
                                    cln = local_name(ch.tag)
                                    if cln == "txBody":
                                        tx_body = ch
                                    elif cln == "replyLst":
                                        for rep in ch:
                                            if local_name(rep.tag) == "reply":
                                                raid = get_attr(rep, "authorId")
                                                rainfo = modern_authors.get(raid, {"name": "Reviewer", "initials": ""})
                                                rtext = "\n".join(extract_drawingml_paragraphs(rep)).strip()
                                                if rtext:
                                                    replies.append({
                                                        "author": rainfo["name"],
                                                        "initials": rainfo["initials"],
                                                        "date": get_attr(rep, "created") or get_attr(rep, "dt"),
                                                        "text": rtext,
                                                    })
                                ctext = "\n".join(extract_drawingml_paragraphs(tx_body if tx_body is not None else cm)).strip()
                                if ctext:
                                    comment_seq += 1
                                    result["comments"].append({
                                        "id": get_attr(cm, "id") or f"ppt-mc-{comment_seq}",
                                        "author": ainfo["name"],
                                        "initials": ainfo["initials"],
                                        "date": dt,
                                        "text": ctext,
                                        "page": idx,
                                        "location": f"Slide {idx} - {slide_title}",
                                        "anchorText": "",
                                        "resolved": resolved,
                                        "replies": replies,
                                    })
                    except Exception:
                        pass

    return result


# ---------------------------------------------------------------------------
# DOCX Parser (comments + reply threads + anchor quotes + footnotes + revisions + outline)
# ---------------------------------------------------------------------------

def parse_docx(file_path: str, page_texts: list = None) -> dict:
    result = {
        "title": "",
        "author": "",
        "outline": [],
        "comments": [],
        "notes": [],
        "revisions": [],
        "sheets": [],
    }
    page_norms = [norm_match(t) for t in (page_texts or [])]

    def locate_page(snippet: str):
        if not page_norms or not snippet:
            return None
        needle = norm_match(snippet)
        if len(needle) < 2:
            return None
        # Try longest snippet first, then fall back to shorter prefixes
        candidates = [needle[:60]]
        if len(needle) > 24:
            candidates.append(needle[:24])
        if len(needle) > 12:
            candidates.append(needle[:12])
        for cand in candidates:
            if len(cand) < 2:
                continue
            for p_idx, ptext in enumerate(page_norms, start=1):
                if cand in ptext:
                    return p_idx
        return None

    with zipfile.ZipFile(file_path, "r") as zf:
        names = set(zf.namelist())
        core = parse_core_properties(zf)
        result["title"] = core["title"]
        result["author"] = core["author"]

        # 1) Scan document body for headings, tracked changes, and comment anchor ranges
        comment_anchors = {}  # cid -> [str]
        active_cids = set()

        if "word/document.xml" in names:
            try:
                droot = ET.fromstring(zf.read("word/document.xml"))
                body = None
                for ch in droot:
                    if local_name(ch.tag) == "body":
                        body = ch
                        break
                if body is not None:
                    for p in body.iter():
                        if local_name(p.tag) == "p":
                            pstyle = ""
                            outline_lvl = None
                            for node in p:
                                if local_name(node.tag) == "pPr":
                                    for pr in node:
                                        pln = local_name(pr.tag)
                                        if pln == "pStyle":
                                            pstyle = get_attr(pr, "val")
                                        elif pln == "outlineLvl":
                                            try:
                                                outline_lvl = int(get_attr(pr, "val")) + 1
                                            except Exception:
                                                pass
                            heading_level = outline_lvl
                            if heading_level is None and pstyle:
                                m = re.match(r"^(?:Heading|TOC\s*Heading)\s*([1-6])$", pstyle, re.IGNORECASE)
                                if m:
                                    heading_level = int(m.group(1))
                            if heading_level is not None and 1 <= heading_level <= 4:
                                htxt = norm_space(extract_word_element_text(p))
                                if htxt:
                                    result["outline"].append({
                                        "level": heading_level,
                                        "title": htxt[:120],
                                        "page": locate_page(htxt),
                                    })

                    # Walk document order to collect commentRangeStart..End and ins/del revisions
                    def walk_doc(node):
                        ln = local_name(node.tag)
                        if ln == "commentRangeStart":
                            cid = get_attr(node, "id")
                            if cid:
                                active_cids.add(cid)
                                comment_anchors.setdefault(cid, [])
                            return
                        if ln == "commentRangeEnd":
                            cid = get_attr(node, "id")
                            if cid:
                                active_cids.discard(cid)
                            return
                        if ln in ("ins", "del"):
                            rev_text = norm_space(extract_word_element_text(node))
                            if rev_text:
                                result["revisions"].append({
                                    "type": "insert" if ln == "ins" else "delete",
                                    "author": get_attr(node, "author") or "Reviewer",
                                    "date": get_attr(node, "date"),
                                    "text": rev_text[:300],
                                    "page": locate_page(rev_text),
                                })
                        if ln == "t" and node.text and active_cids:
                            for cid in active_cids:
                                comment_anchors[cid].append(node.text)
                        for ch in node:
                            walk_doc(ch)

                    walk_doc(body)
            except Exception:
                pass

        # 2) Parse commentsExtended.xml (resolved status and parent/reply threading)
        ext_by_para = {}  # paraId -> {parentParaId, done}
        if "word/commentsExtended.xml" in names:
            try:
                eroot = ET.fromstring(zf.read("word/commentsExtended.xml"))
                for ex in eroot.iter():
                    if local_name(ex.tag) == "commentEx":
                        pid = get_attr(ex, "paraId")
                        if pid:
                            ext_by_para[pid] = {
                                "parentParaId": get_attr(ex, "paraIdParent"),
                                "done": get_attr(ex, "done") in ("1", "true", "True"),
                            }
            except Exception:
                pass

        # 3) Parse word/comments.xml
        if "word/comments.xml" in names:
            try:
                croot = ET.fromstring(zf.read("word/comments.xml"))
                raw_comments = []
                para_to_comment = {}
                for cm in croot:
                    if local_name(cm.tag) != "comment":
                        continue
                    cid = get_attr(cm, "id")
                    author = get_attr(cm, "author") or "Reviewer"
                    initials = get_attr(cm, "initials")
                    dt = get_attr(cm, "date")
                    ctext = extract_word_element_text(cm)
                    # Word indexes commentsExtended via the last paragraph's paraId
                    para_ids = []
                    for p in cm.iter():
                        if local_name(p.tag) == "p":
                            pid = get_attr(p, "paraId")
                            if pid:
                                para_ids.append(pid)
                    ext_info = {}
                    for pid in reversed(para_ids):
                        if pid in ext_by_para:
                            ext_info = ext_by_para[pid]
                            break

                    anchor = norm_space("".join(comment_anchors.get(cid, [])))[:240]
                    page_num = locate_page(anchor) or locate_page(ctext[:30])
                    item = {
                        "id": cid,
                        "author": author,
                        "initials": initials,
                        "date": dt,
                        "text": ctext,
                        "page": page_num,
                        "location": f"Page {page_num}" if page_num else "Body Comment",
                        "anchorText": anchor,
                        "resolved": bool(ext_info.get("done", False)),
                        "parentParaId": ext_info.get("parentParaId", ""),
                        "paraIds": para_ids,
                        "replies": [],
                    }
                    raw_comments.append(item)
                    for pid in para_ids:
                        para_to_comment[pid] = item

                # Assemble reply threads
                top_comments = []
                for item in raw_comments:
                    parent_pid = item.pop("parentParaId", "")
                    item.pop("paraIds", None)
                    parent_item = para_to_comment.get(parent_pid) if parent_pid else None
                    if parent_item and parent_item is not item:
                        parent_item["replies"].append({
                            "author": item["author"],
                            "initials": item["initials"],
                            "date": item["date"],
                            "text": item["text"],
                        })
                    else:
                        top_comments.append(item)
                result["comments"] = top_comments
            except Exception:
                pass

        # 4) Parse footnotes and endnotes
        for part_name, note_kind, label_prefix in (
            ("word/footnotes.xml", "footnote", "Footnote"),
            ("word/endnotes.xml", "endnote", "Endnote"),
        ):
            if part_name not in names:
                continue
            try:
                nroot = ET.fromstring(zf.read(part_name))
                for fn in nroot:
                    ln = local_name(fn.tag)
                    if ln not in ("footnote", "endnote"):
                        continue
                    ftype = get_attr(fn, "type").lower()
                    fid = get_attr(fn, "id")
                    if ftype in ("separator", "continuationseparator", "continuationnotice"):
                        continue
                    if fid in ("-1", "0"):
                        continue
                    txt = extract_word_element_text(fn)
                    if txt:
                        pnum = locate_page(txt[:30])
                        result["notes"].append({
                            "id": f"{note_kind}-{fid}",
                            "kind": note_kind,
                            "page": pnum,
                            "label": f"{label_prefix} [{fid}]",
                            "text": txt,
                        })
            except Exception:
                pass

    return result


# ---------------------------------------------------------------------------
# XLSX Parser (multi-sheet grid + legacy & M365 threaded cell comments)
# ---------------------------------------------------------------------------

def col_letters_to_index(letters: str) -> int:
    idx = 0
    for ch in letters.upper():
        if "A" <= ch <= "Z":
            idx = idx * 26 + (ord(ch) - ord("A") + 1)
    return max(0, idx - 1)


def parse_cell_ref(ref: str):
    m = re.match(r"^([A-Za-z]+)(\d+)$", (ref or "").strip())
    if not m:
        return None, None
    return int(m.group(2)) - 1, col_letters_to_index(m.group(1))


def parse_xlsx(file_path: str, max_rows: int = 300, max_cols: int = 50) -> dict:
    result = {
        "title": "",
        "author": "",
        "outline": [],
        "comments": [],
        "notes": [],
        "revisions": [],
        "sheets": [],
    }
    with zipfile.ZipFile(file_path, "r") as zf:
        names = set(zf.namelist())
        core = parse_core_properties(zf)
        result["title"] = core["title"]
        result["author"] = core["author"]

        # 1) Shared strings table
        shared_strings = []
        if "xl/sharedStrings.xml" in names:
            try:
                sroot = ET.fromstring(zf.read("xl/sharedStrings.xml"))
                for si in sroot:
                    if local_name(si.tag) != "si":
                        continue
                    parts = [t.text for t in si.iter() if local_name(t.tag) == "t" and t.text]
                    shared_strings.append("".join(parts))
            except Exception:
                pass

        # 2) Microsoft 365 person table for threaded comments
        persons = {}
        if "xl/persons/person.xml" in names:
            try:
                proot = ET.fromstring(zf.read("xl/persons/person.xml"))
                for p in proot.iter():
                    if local_name(p.tag) == "person":
                        pid = get_attr(p, "id")
                        persons[pid] = get_attr(p, "displayName") or "Reviewer"
            except Exception:
                pass

        # 3) Worksheet order
        sheet_entries = []
        if "xl/workbook.xml" in names:
            wb_rels = parse_rels(zf, "xl/workbook.xml")
            try:
                wroot = ET.fromstring(zf.read("xl/workbook.xml"))
                for sh in wroot.iter():
                    if local_name(sh.tag) == "sheet":
                        sname = get_attr(sh, "name") or "Sheet"
                        rel_id = ""
                        for k, v in sh.attrib.items():
                            if k.endswith("}id"):
                                rel_id = v
                                break
                        if rel_id and rel_id in wb_rels:
                            sheet_entries.append((sname, wb_rels[rel_id]["target"]))
            except Exception:
                pass

        comment_seq = 0
        for s_idx, (sname, spart) in enumerate(sheet_entries):
            if spart not in names:
                continue
            sheet_comments_map = {}  # "row:col" -> comment obj
            srels = parse_rels(zf, spart)

            # Parse sheet comments (threaded + legacy)
            for rel in srels.values():
                target = rel["target"]
                rtype = rel["type"].lower()
                if target not in names:
                    continue
                if "threadedcomment" in rtype or "threadedcomments/" in target.lower():
                    try:
                        troot = ET.fromstring(zf.read(target))
                        threads = {}
                        for tc in troot:
                            if local_name(tc.tag) != "threadedComment":
                                continue
                            ref = get_attr(tc, "ref")
                            cid = get_attr(tc, "id")
                            parent_id = get_attr(tc, "parentId")
                            pid = get_attr(tc, "personId")
                            author = persons.get(pid, "Reviewer")
                            dt = get_attr(tc, "dT")
                            resolved = get_attr(tc, "done") in ("1", "true", "True")
                            txt_parts = [ch.text for ch in tc if local_name(ch.tag) == "text" and ch.text]
                            ctext = "\n".join(txt_parts).strip()
                            if not ctext:
                                continue
                            r_i, c_i = parse_cell_ref(ref)
                            if parent_id and parent_id in threads:
                                threads[parent_id]["replies"].append({
                                    "author": author,
                                    "initials": "",
                                    "date": dt,
                                    "text": ctext,
                                })
                            else:
                                comment_seq += 1
                                obj = {
                                    "id": cid or f"xls-tc-{comment_seq}",
                                    "author": author,
                                    "initials": "",
                                    "date": dt,
                                    "text": ctext,
                                    "page": s_idx + 1,
                                    "sheetIndex": s_idx,
                                    "sheetName": sname,
                                    "cellRef": ref,
                                    "row": r_i,
                                    "col": c_i,
                                    "location": f"{sname}!{ref}",
                                    "anchorText": "",
                                    "resolved": resolved,
                                    "replies": [],
                                }
                                threads[cid] = obj
                                result["comments"].append(obj)
                                if r_i is not None and c_i is not None:
                                    sheet_comments_map[f"{r_i}:{c_i}"] = obj
                    except Exception:
                        pass
                elif "comments" in rtype or re.search(r"xl/comments\d*\.xml$", target):
                    try:
                        croot = ET.fromstring(zf.read(target))
                        authors = []
                        for node in croot.iter():
                            if local_name(node.tag) == "author":
                                authors.append((node.text or "").strip() or "Reviewer")
                        for cm in croot.iter():
                            if local_name(cm.tag) != "comment":
                                continue
                            ref = get_attr(cm, "ref")
                            a_idx = get_attr(cm, "authorId")
                            author = "Reviewer"
                            try:
                                if a_idx != "" and int(a_idx) < len(authors):
                                    author = authors[int(a_idx)]
                            except Exception:
                                pass
                            parts = [t.text for t in cm.iter() if local_name(t.tag) == "t" and t.text]
                            ctext = "".join(parts).strip()
                            if not ctext:
                                continue
                            r_i, c_i = parse_cell_ref(ref)
                            comment_seq += 1
                            obj = {
                                "id": f"xls-c-{comment_seq}",
                                "author": author,
                                "initials": "",
                                "date": "",
                                "text": ctext,
                                "page": s_idx + 1,
                                "sheetIndex": s_idx,
                                "sheetName": sname,
                                "cellRef": ref,
                                "row": r_i,
                                "col": c_i,
                                "location": f"{sname}!{ref}",
                                "anchorText": "",
                                "resolved": False,
                                "replies": [],
                            }
                            result["comments"].append(obj)
                            if r_i is not None and c_i is not None:
                                sheet_comments_map[f"{r_i}:{c_i}"] = obj
                    except Exception:
                        pass

            # Parse worksheet cells
            rows_dict = {}
            actual_max_row = 0
            actual_max_col = 0
            truncated = False
            try:
                sroot = ET.fromstring(zf.read(spart))
                for row_elem in sroot.iter():
                    if local_name(row_elem.tag) != "row":
                        continue
                    r_attr = get_attr(row_elem, "r")
                    r_idx = (int(r_attr) - 1) if r_attr.isdigit() else len(rows_dict)
                    actual_max_row = max(actual_max_row, r_idx + 1)
                    if r_idx >= max_rows:
                        truncated = True
                        continue
                    for cell in row_elem:
                        if local_name(cell.tag) != "c":
                            continue
                        cref = get_attr(cell, "r")
                        _, c_idx = parse_cell_ref(cref)
                        if c_idx is None:
                            c_idx = len(rows_dict.get(r_idx, {}))
                        actual_max_col = max(actual_max_col, c_idx + 1)
                        if c_idx >= max_cols:
                            truncated = True
                            continue
                        ctype = get_attr(cell, "t")
                        val = ""
                        if ctype == "inlineStr":
                            val = "".join(t.text for t in cell.iter() if local_name(t.tag) == "t" and t.text)
                        else:
                            vnode = None
                            for ch in cell:
                                if local_name(ch.tag) == "v":
                                    vnode = ch
                                    break
                            raw_v = (vnode.text or "") if vnode is not None else ""
                            if ctype == "s":
                                try:
                                    val = shared_strings[int(raw_v)]
                                except Exception:
                                    val = raw_v
                            elif ctype == "b":
                                val = "TRUE" if raw_v == "1" else "FALSE"
                            else:
                                val = raw_v
                        if val != "":
                            rows_dict.setdefault(r_idx, {})[c_idx] = val
            except Exception:
                pass

            disp_rows = min(actual_max_row, max_rows)
            disp_cols = min(actual_max_col, max_cols)
            grid = []
            for r in range(disp_rows):
                rmap = rows_dict.get(r, {})
                grid.append([rmap.get(c, "") for c in range(disp_cols)])

            # Populate anchorText from the commented cell's current value
            for key, cm_obj in sheet_comments_map.items():
                r_i = cm_obj.get("row")
                c_i = cm_obj.get("col")
                if r_i is not None and c_i is not None and 0 <= r_i < len(grid) and 0 <= c_i < len(grid[r_i]):
                    cell_val = str(grid[r_i][c_i]).strip()
                    if cell_val:
                        cm_obj["anchorText"] = cell_val[:120]

            result["sheets"].append({
                "index": s_idx,
                "name": sname,
                "rowCount": actual_max_row,
                "colCount": actual_max_col,
                "truncated": truncated,
                "rows": grid,
                "comments": {
                    k: {
                        "id": v["id"],
                        "ref": v["cellRef"],
                        "author": v["author"],
                        "text": v["text"],
                        "resolved": v["resolved"],
                    }
                    for k, v in sheet_comments_map.items()
                },
            })
            result["outline"].append({
                "level": 1,
                "title": f"{sname} ({actual_max_row}x{actual_max_col})",
                "page": s_idx + 1,
                "sheetIndex": s_idx,
            })

    return result


def parse_csv_file(file_path: str, max_rows: int = 400, max_cols: int = 50) -> dict:
    raw = Path(file_path).read_bytes()
    text = None
    for enc in ("utf-8-sig", "utf-8", "cp1252", "latin-1"):
        try:
            text = raw.decode(enc)
            break
        except Exception:
            continue
    text = text or ""
    delimiter = "\t" if file_path.lower().endswith(".tsv") else ","
    reader = csv.reader(text.splitlines(), delimiter=delimiter)
    rows = []
    max_c = 0
    total_rows = 0
    truncated = False
    for row in reader:
        total_rows += 1
        max_c = max(max_c, len(row))
        if len(rows) < max_rows:
            rows.append(row[:max_cols])
            if len(row) > max_cols:
                truncated = True
        else:
            truncated = True
    return {
        "title": Path(file_path).name,
        "author": "",
        "outline": [{"level": 1, "title": Path(file_path).name, "page": 1, "sheetIndex": 0}],
        "comments": [],
        "notes": [],
        "revisions": [],
        "sheets": [{
            "index": 0,
            "name": Path(file_path).stem,
            "rowCount": total_rows,
            "colCount": max_c,
            "truncated": truncated,
            "rows": rows,
            "comments": {},
        }],
    }


# ---------------------------------------------------------------------------
# PDF metadata, outline, page text, and annotations (via PyMuPDF)
# ---------------------------------------------------------------------------

def inspect_pdf_with_fitz(pdf_path: str, extract_annotations: bool = False) -> dict:
    info = {
        "pageCount": 0,
        "pages": [],
        "pageTexts": [],
        "outline": [],
        "comments": [],
        "title": "",
        "author": "",
    }
    if not HAS_FITZ or not pdf_path or not os.path.isfile(pdf_path):
        return info
    doc = fitz.open(pdf_path)
    try:
        meta = doc.metadata or {}
        info["title"] = (meta.get("title") or "").strip()
        info["author"] = (meta.get("author") or "").strip()
        info["pageCount"] = len(doc)

        # Bookmarks / Table of Contents
        for lvl, title, page_num in doc.get_toc(simple=True):
            if title:
                info["outline"].append({
                    "level": max(1, min(4, int(lvl))),
                    "title": norm_space(title)[:120],
                    "page": max(1, int(page_num)),
                })

        annot_seq = 0
        for i, page in enumerate(doc, start=1):
            rect = page.rect
            ptext = page.get_text("text") or ""
            info["pageTexts"].append(ptext)
            first_line = next((norm_space(l) for l in ptext.splitlines() if norm_space(l)), "")
            info["pages"].append({
                "page": i,
                "width": round(rect.width, 1),
                "height": round(rect.height, 1),
                "snippet": first_line[:100],
            })

            if extract_annotations:
                annots = page.annots()
                if annots:
                    for annot in annots:
                        atype = (annot.type[1] if annot.type and len(annot.type) > 1 else "").strip()
                        if atype.lower() in ("link", "widget", "popup"):
                            continue
                        ainfo = annot.info or {}
                        content = (ainfo.get("content") or "").strip()
                        author = (ainfo.get("title") or "").strip() or "PDF Annotation"
                        mod_date = (ainfo.get("modDate") or ainfo.get("creationDate") or "").strip()
                        anchor = ""
                        try:
                            anchor = norm_space(page.get_textbox(annot.rect))[:200]
                        except Exception:
                            pass
                        if not content and not anchor:
                            continue
                        annot_seq += 1
                        info["comments"].append({
                            "id": f"pdf-a-{annot_seq}",
                            "author": author,
                            "initials": "",
                            "date": mod_date,
                            "text": content or f"[{atype}]",
                            "page": i,
                            "location": f"Page {i} - {atype or 'Annotation'}",
                            "anchorText": anchor,
                            "resolved": False,
                            "replies": [],
                        })
    finally:
        doc.close()
    return info


# ---------------------------------------------------------------------------
# CLI Entry Point
# ---------------------------------------------------------------------------

def cmd_inspect(args):
    file_path = os.path.abspath(args.file)
    pdf_path = os.path.abspath(args.pdf) if args.pdf else ""
    ext = Path(file_path).suffix.lower()

    kind_map = {
        ".pptx": "pptx", ".ppt": "pptx", ".odp": "pptx",
        ".docx": "docx", ".doc": "docx", ".odt": "docx", ".rtf": "docx",
        ".xlsx": "xlsx", ".xls": "xlsx", ".ods": "xlsx",
        ".csv": "csv", ".tsv": "csv",
        ".pdf": "pdf",
    }
    kind = kind_map.get(ext, "unknown")

    actual_pdf = file_path if ext == ".pdf" else pdf_path
    pdf_info = inspect_pdf_with_fitz(actual_pdf, extract_annotations=(ext == ".pdf"))

    parsed = {
        "title": "",
        "author": "",
        "outline": [],
        "comments": [],
        "notes": [],
        "revisions": [],
        "sheets": [],
    }

    if ext == ".pptx":
        parsed = parse_pptx(file_path)
    elif ext == ".docx":
        parsed = parse_docx(file_path, page_texts=pdf_info["pageTexts"])
    elif ext == ".xlsx":
        parsed = parse_xlsx(file_path)
    elif ext in (".csv", ".tsv"):
        parsed = parse_csv_file(file_path)
    elif ext == ".pdf":
        parsed["title"] = pdf_info["title"]
        parsed["author"] = pdf_info["author"]
        parsed["outline"] = pdf_info["outline"]
        parsed["comments"] = pdf_info["comments"]

    # Merge slide titles into PDF page list when inspecting PPTX
    pages = pdf_info["pages"]
    if ext == ".pptx" and parsed.get("slides"):
        slide_titles = {s["page"]: s["title"] for s in parsed["slides"]}
        if pages:
            for p in pages:
                p["title"] = slide_titles.get(p["page"], p.get("snippet", ""))
        else:
            pages = [{"page": s["page"], "width": 960, "height": 540, "title": s["title"]} for s in parsed["slides"]]

    outline = parsed["outline"] if parsed["outline"] else pdf_info["outline"]
    page_count = pdf_info["pageCount"] or len(pages) or (len(parsed["sheets"]) if kind in ("xlsx", "csv") else 0)

    output = {
        "ok": True,
        "kind": kind,
        "ext": ext,
        "fileName": Path(file_path).name,
        "title": parsed["title"] or pdf_info["title"] or Path(file_path).stem,
        "author": parsed["author"] or pdf_info["author"],
        "pageCount": page_count,
        "pages": pages,
        "outline": outline,
        "comments": parsed["comments"],
        "notes": parsed["notes"],
        "revisions": parsed["revisions"],
        "sheets": parsed["sheets"],
        "capabilities": {
            "hasFitz": HAS_FITZ,
            "hasPdf": bool(actual_pdf and os.path.isfile(actual_pdf)),
        },
    }
    sys.stdout.write(json.dumps(output, ensure_ascii=False))


def cmd_render(args):
    if not HAS_FITZ:
        sys.stdout.write(json.dumps({
            "ok": False,
            "error": "PyMuPDF (fitz) is not installed; use the embedded PDF fallback or install pymupdf.",
        }, ensure_ascii=False))
        return
    pdf_path = os.path.abspath(args.pdf)
    out_path = os.path.abspath(args.output)
    page_num = max(1, int(args.page))
    scale = max(0.5, min(3.5, float(args.scale)))

    doc = fitz.open(pdf_path)
    try:
        if page_num > len(doc):
            page_num = len(doc)
        page = doc[page_num - 1]
        mat = fitz.Matrix(scale, scale)
        pix = page.get_pixmap(matrix=mat, alpha=False)
        os.makedirs(os.path.dirname(out_path), exist_ok=True)
        tmp_path = f"{out_path}.{os.getpid()}.tmp.png"
        pix.save(tmp_path)
        os.replace(tmp_path, out_path)
        sys.stdout.write(json.dumps({
            "ok": True,
            "page": page_num,
            "width": pix.width,
            "height": pix.height,
            "bytes": os.path.getsize(out_path),
        }, ensure_ascii=False))
    finally:
        doc.close()


def main():
    parser = argparse.ArgumentParser(description="Office Preview Inspector & Renderer")
    sub = parser.add_subparsers(dest="cmd", required=True)

    p_ins = sub.add_parser("inspect")
    p_ins.add_argument("file")
    p_ins.add_argument("--pdf", default="")
    p_ins.set_defaults(func=cmd_inspect)

    p_ren = sub.add_parser("render")
    p_ren.add_argument("pdf")
    p_ren.add_argument("page", type=int)
    p_ren.add_argument("output")
    p_ren.add_argument("--scale", type=float, default=2.0)
    p_ren.set_defaults(func=cmd_render)

    args = parser.parse_args()
    try:
        args.func(args)
    except Exception as exc:
        sys.stdout.write(json.dumps({"ok": False, "error": str(exc)}, ensure_ascii=False))
        sys.exit(1)


if __name__ == "__main__":
    main()
