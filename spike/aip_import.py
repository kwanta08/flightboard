"""AIP の PDF（SWIM の AIP ファイルダウンロードサービス）から SID/STAR/IAP を抽出し、座標つきの手順データを作る。

Phase 0.5 の検証用スクリプト。検証結果と設計は docs/spec.md の 10.3 を参照。

    python spike/aip_import.py --enr ENR_20260903.pdf \
        --ad2 RJTT__20260903.pdf RJAA__20260903.pdf \
        --runways runways.csv --out data/aip/procedures.json

依存: PyMuPDF（AGPL-3.0。個人利用なら問題ないが、配布するならライセンスに注意）
"""

import argparse
import collections
import csv
import json
import math
import re
import sys
from datetime import datetime, timezone
from pathlib import Path

import pymupdf

NM = 1.852
LAT = re.compile(r"^(\d{2})(\d{2})(\d{2}(?:\.\d+)?)N$")
LON = re.compile(r"^(\d{3})(\d{2})(\d{2}(?:\.\d+)?)E$")
JOINED_COORDINATES = re.compile(r"^(\d{6}(?:\.\d+)?N)/(\d{7}(?:\.\d+)?E)$")
FIX = r"(?:RW\d{2}[LRC]?|[A-Z][A-Z0-9]{4})"
ROLES = r"IAF|IF|FAF|FAP|MAPt|MATF|MAHF"
LABELED_FIX = re.compile(rf"^([A-Z][A-Z0-9]{{4}})\((?:{ROLES})\)$")
ROLE_LABEL = re.compile(rf"\b({FIX})\s*\(\s*({ROLES})\s*\)")
SEGMENT_NOTE = re.compile(r"(\d{1,2}\.\d)\s+(\d{3})°\s*\((\d{3}\.\d)°T\)")
PATH_TERMINATORS = {
    "IF", "TF", "CF", "DF", "FA", "FC", "FD", "FM", "CA", "CD", "CI", "CR",
    "RF", "AF", "VA", "VD", "VI", "VM", "VR", "PI", "HA", "HF", "HM",
}
TABLE_COLUMNS = [
    "Serial", "Path", "Waypoint", "Fly", "Course", "Magnetic",
    "Distance", "Turn", "Altitude", "Speed", "Vertical", "Navigation",
]
APPROACH_TITLE = (r"(?:ILS|LOC|LDA|RNP|RNAV|VOR|NDB|GLS)(?: [A-Z])?(?: or (?:ILS|LOC|LDA)(?: [A-Z])?)?"
                  r" RWY ?\d{2}[LRC]?(?: ?\(AR\))?")
TITLE_LINE = re.compile(rf"^(?:[A-Z][A-Z0-9 ]{{2,40}} (?:DEPARTURE|ARRIVAL)|{APPROACH_TITLE})$")
SECTION_LINE = re.compile(
    r"^(RWY ?\d{2}[LRC]?(?: ?/ ?(?:RWY ?)?\d{2}[LRC]?)*|[A-Z][A-Z0-9 ]+ TRANSITION)$"
)
# 空港からこれ以上離れた同名の地点は別物とみなす（実例: ENR 4.3 の DAITO は成田の DAITO と 1,377km 離れている）
MAX_FIX_DISTANCE_KM = 400
# LDA・VOR など、最終進入が滑走路の向きからこれ以上ずれていれば、最後に目視で正対する区間を補う
OFFSET_FINAL_DEG = 3
VISUAL_SEGMENT_NM = 2


def dms(match):
    d, m, s = match.groups()
    return round(int(d) + int(m) / 60 + float(s) / 3600, 7)


def km(a, b):
    p = math.pi / 180
    x = math.sin((b[0] - a[0]) * p / 2)
    y = math.sin((b[1] - a[1]) * p / 2)
    return 2 * 6371 * math.asin(math.sqrt(x * x + math.cos(a[0] * p) * math.cos(b[0] * p) * y * y))


def bearing(a, b):
    p = math.pi / 180
    y = math.sin((b[1] - a[1]) * p) * math.cos(b[0] * p)
    x = math.cos(a[0] * p) * math.sin(b[0] * p) - math.sin(a[0] * p) * math.cos(b[0] * p) * math.cos((b[1] - a[1]) * p)
    return (math.degrees(math.atan2(y, x)) + 360) % 360


def destination(point, course, distance_km):
    p = math.pi / 180
    lat, lon, course, d = point[0] * p, point[1] * p, course * p, distance_km / 6371
    lat2 = math.asin(math.sin(lat) * math.cos(d) + math.cos(lat) * math.sin(d) * math.cos(course))
    lon2 = lon + math.atan2(math.sin(course) * math.sin(d) * math.cos(lat), math.cos(d) - math.sin(lat) * math.sin(lat2))
    return [lat2 / p, lon2 / p]


def heading_diff(a, b):
    return abs((a - b + 540) % 360 - 180)


def center_y(word):
    return (word[1] + word[3]) / 2


def center_x(word):
    return (word[0] + word[2]) / 2


def is_enr_section(page, section):
    head = page.get_text(clip=pymupdf.Rect(0, 0, page.rect.width, 70))
    return re.search(rf"ENR\s*{re.escape(section)}-\d+", head) is not None


def page_lines(page):
    for block in page.get_text("dict")["blocks"]:
        for line in block.get("lines", []):
            # \s を使うと、文字コードがずれた数字（\x1c = "9" など）まで空白とみなしてしまう
            text = re.sub(r"[ \t\r\n]+", " ", " ".join(span["text"] for span in line["spans"])).strip()
            if text:
                yield line["bbox"][1], text


def decode_shifted(text):
    """一部のフォントは、英大文字以外の文字コードが 29 ずれて抽出される（例: "R:<\\x16\\x17/" → "RWY34L"）。"""
    return "".join(chr(ord(c) + 29) if 0x03 <= ord(c) <= 0x3D and c != " " else c for c in text)


# ---------------------------------------------------------------------------
# ウェイポイントの座標
#
# pdftotext -layout のテキストでは表の列がずれて、名前と座標が別の行に対応づいてしまう
# （実例: 同じ座標が HOBBS・BASSA・BAYGE に割り当たった）。必ず単語の位置座標で行を組み立てる。
# ---------------------------------------------------------------------------

def extract_significant_points(doc):
    """ENR 4.3（重要地点の名称コード）。名前と緯度・経度が別の行に折り返されることがある。"""
    points, mismatched_pages = {}, []
    for page in doc:
        if not is_enr_section(page, "4.3"):
            continue
        words = page.get_text("words")
        names = sorted(
            (w for w in words if re.fullmatch(r"[A-Z]{5}", w[4]) and w[0] < page.rect.width * 0.30),
            key=lambda w: w[1],
        )
        pairs = _pair_coordinates(words)
        if len(names) == len(pairs):
            matched = zip(names, pairs)
        else:
            mismatched_pages.append(page.number + 1)
            matched = _match_by_nearest_row(names, pairs)
        for name, (lat, lon) in matched:
            points[name[4]] = [dms(LAT.match(lat[4])), dms(LON.match(lon[4]))]
    return points, mismatched_pages


def _pair_coordinates(words):
    """上から順に並べると緯度・経度が交互に現れるので、隣り合う 2 つを組にする。"""
    coords = sorted((w for w in words if LAT.match(w[4]) or LON.match(w[4])), key=lambda w: (w[1], w[0]))
    pairs, i = [], 0
    while i < len(coords) - 1:
        a, b = coords[i], coords[i + 1]
        if LAT.match(a[4]) and LON.match(b[4]):
            pairs.append((a, b))
            i += 2
        elif LON.match(a[4]) and LAT.match(b[4]) and abs(a[1] - b[1]) < 2:
            pairs.append((b, a))
            i += 2
        else:
            i += 1
    return sorted(pairs, key=lambda p: min(p[0][1], p[1][1]))


def _match_by_nearest_row(names, pairs):
    used = set()
    for name in names:
        best, best_distance = None, float("inf")
        for k, (a, b) in enumerate(pairs):
            if k in used:
                continue
            top, bottom = min(a[1], b[1]), max(a[3], b[3])
            y = center_y(name)
            distance = 0 if top <= y <= bottom else min(abs(y - top), abs(y - bottom))
            if distance < best_distance:
                best, best_distance = k, distance
        if best is not None and best_distance < 8:
            used.add(best)
            yield name, pairs[best]


def extract_navaids(doc):
    """ENR 4.1（航法援助施設）。ID 列の位置にある 2〜3 文字を識別子とする。"""
    navaids = {}
    for page in doc:
        if not is_enr_section(page, "4.1"):
            continue
        words = page.get_text("words")
        id_header = next((w for w in words if w[4] == "ID"), None)
        for lat in (w for w in words if LAT.match(w[4])):
            y = center_y(lat)
            lon = next((w for w in words if LON.match(w[4]) and abs(center_y(w) - y) < 12
                        and abs(w[0] - lat[0]) < 30 and w[1] >= lat[1] - 2), None)
            ident = next((w for w in words if re.fullmatch(r"[A-Z]{2,3}", w[4]) and abs(center_y(w) - y) < 4
                          and (id_header is None or abs(center_x(w) - center_x(id_header)) < 25)), None)
            if lon and ident:
                navaids.setdefault(ident[4], [dms(LAT.match(lat[4])), dms(LON.match(lon[4]))])
    return navaids


def normalized_words(page):
    """IAC では "APOLO(FAF)" や "351919.32N/1395614.78E" のように、名前や座標が他の文字とつながっている。"""
    words = []
    for x0, y0, x1, y1, text, *_ in page.get_text("words"):
        if m := JOINED_COORDINATES.match(text):
            split = x0 + (x1 - x0) * (len(m.group(1)) + 0.5) / len(text)
            words += [(x0, y0, split, y1, m.group(1)), (split, y0, x1, y1, m.group(2))]
        elif m := LABELED_FIX.match(text):
            words.append((x0, y0, x1, y1, m.group(1)))
        else:
            words.append((x0, y0, x1, y1, text))
    return words


def extract_terminal_waypoints(doc):
    """AD2.24 の空港周辺ウェイポイント表。同じ点が複数ページに載るので、食い違いを数えて多数決を取る。"""
    observations = collections.defaultdict(list)
    for page in doc:
        words = normalized_words(page)
        lats = [w for w in words if LAT.match(w[4])]
        if not lats:
            continue
        lons = [w for w in words if LON.match(w[4])]
        names = [w for w in words if re.fullmatch(r"(?!RWY)[A-Z][A-Z0-9]{4}", w[4])]
        for lat in lats:
            y = center_y(lat)
            # 経度は緯度の右隣にあるのが普通だが、IAC の座標欄では緯度の真下に折り返されている
            beside = (w for w in lons if abs(center_y(w) - y) < 4 and 0 <= w[0] - lat[2] < 60)
            below = (w for w in lons if 5 < center_y(w) - y < 14 and abs(w[0] - lat[0]) < 12)
            lon = min(beside, key=lambda w: w[0], default=None) or min(below, key=center_y, default=None)
            name = max((w for w in names if abs(center_y(w) - y) < 4 and 0 <= lat[0] - w[2] < 150),
                       key=lambda w: w[2], default=None)
            if lon and name:
                observations[name[4]].append((dms(LAT.match(lat[4])), dms(LON.match(lon[4]))))

    points, conflicts = {}, []
    for name, seen in observations.items():
        if any(km(seen[0], other) > 0.03 for other in seen):
            conflicts.append(name)
        buckets = collections.defaultdict(list)
        for point in seen:
            buckets[(round(point[0], 4), round(point[1], 4))].append(point)
        majority = max(buckets.values(), key=len)
        points[name] = [sum(p[0] for p in majority) / len(majority), sum(p[1] for p in majority) / len(majority)]
    return points, conflicts


def load_runway_ends(path, icao):
    """OurAirports の runways.csv から、滑走路端（RW23 など）の位置・真方位・反対側の端を作る。"""
    ends = {}
    with open(path, encoding="utf-8") as f:
        for row in csv.DictReader(f):
            if row["airport_ident"] != icao:
                continue
            for end, other in (("le", "he"), ("he", "le")):
                if row[f"{end}_latitude_deg"]:
                    ends[row[f"{end}_ident"]] = {
                        "fix": "RW" + row[f"{end}_ident"],
                        "point": [float(row[f"{end}_latitude_deg"]), float(row[f"{end}_longitude_deg"])],
                        "heading": float(row[f"{end}_heading_degT"] or "nan"),
                        "opposite": row[f"{other}_ident"],
                    }
    return ends


def make_locator(sources, center):
    """ウェイポイント名 → (座標, 出典)。sources は優先度の高い順。"""
    def locate(name):
        for source, table in sources:
            point = table.get(name)
            if point and km(point, center) < MAX_FIX_DISTANCE_KM:
                return point, source
        return None, None
    return locate


# ---------------------------------------------------------------------------
# 手順表（SID/STAR と、表のある IAP）
# ---------------------------------------------------------------------------

def classify(title, section):
    if section and section.endswith("TRANSITION"):
        return "TRANS"
    if title and re.fullmatch(APPROACH_TITLE, title):
        return "IAP"
    if title and title.endswith("DEPARTURE"):
        return "SID"
    if title and title.endswith("ARRIVAL"):
        return "STAR"
    return "UNKNOWN"


def column_tokens(words, row, columns, column, band):
    """行の中心から band 以内にあり、見出しの x 位置が column に最も近い単語（行の中心に近い順）。"""
    near = [w for w in words if w is not row and abs(center_y(w) - center_y(row)) < band
            and min(columns, key=lambda c: abs(columns[c] - center_x(w))) == column]
    return [w[4] for w in sorted(near, key=lambda w: abs(center_y(w) - center_y(row)))]


def extract_procedures(doc, icao):
    """AD2.24 のコード化された手順表（Serial / Path Descriptor / Waypoint Identifier / Altitude ...）を読む。

    表はページをまたぐので、経路名のないページは直前の経路名を引き継ぎ、通し番号 001 で新しい手順を始める。
    これをしないと、別の手順の区間が混ざる。
    """
    procedures, carry_title, carry_section = [], None, None
    for page in doc:
        words = page.get_text("words")
        headers = sorted((w for w in words if w[4] == "Serial"), key=lambda w: w[1])
        if not headers:
            continue
        lines = list(page_lines(page))
        titles = [(y, t) for y, t in lines if TITLE_LINE.match(t) and not t.startswith(("STANDARD", "INSTRUMENT"))]
        sections = [(y, t.replace(" ", "")) for y, t in lines if SECTION_LINE.match(t)]

        for i, header in enumerate(headers):
            top = header[1]
            bottom = headers[i + 1][1] if i + 1 < len(headers) else float("inf")
            columns = {w[4]: center_x(w) for w in words if abs(w[1] - top) < 3 and w[4] in TABLE_COLUMNS}
            if not {"Serial", "Path", "Waypoint"} <= columns.keys():
                continue

            above = [t for t in titles if t[0] < top]
            if above:
                title_y, title = max(above)
                section = max((s for s in sections if title_y < s[0] < top), default=(0, None))[1]
            else:
                title = carry_title
                section = max((s for s in sections if s[0] < top), default=(0, carry_section))[1]
            carry_title, carry_section = title, section

            rows = sorted((w for w in words if re.fullmatch(r"\d{3}", w[4]) and top < w[1] < bottom
                           and abs(center_x(w) - columns["Serial"]) < 25), key=lambda w: w[1])
            current = None
            for row in rows:
                if row[4] == "001" or current is None:
                    current = {"airport": icao, "kind": classify(title, section), "name": title,
                               "section": section, "page": page.number + 1, "method": "table", "legs": []}
                    procedures.append(current)
                current["legs"].append(read_leg(words, row, columns))
    return procedures


def read_leg(words, row, columns):
    cell = lambda column, band=8: column_tokens(words, row, columns, column, band)
    # RF の Path 欄は "RF / Center: / TTRF1 / r=3.10NM" と縦に 4 行あるので、広めに拾う
    path = cell("Path", 22)
    leg = {
        "seq": row[4],
        "pathTerminator": next((t for t in path if t in PATH_TERMINATORS), None),
        "fix": next((t for t in cell("Waypoint")
                     if re.fullmatch(r"[A-Z][A-Z0-9]{2,4}", t) and t not in PATH_TERMINATORS), None),
        "altitude": " ".join(t for t in cell("Altitude") if t not in ("–", "-")) or None,
        "flyOver": "Y" in cell("Fly"),
        "turn": next((t for t in cell("Turn") if t in ("L", "R")), None),
    }
    if leg["pathTerminator"] == "RF":
        leg["centerFix"] = next((t for t in path if re.fullmatch(r"[A-Z][A-Z0-9]{4}", t) and t not in PATH_TERMINATORS), None)
        radius = next((m for t in path if (m := re.fullmatch(r"r=([\d.]+)NM", t))), None)
        leg["radiusNm"] = float(radius.group(1)) if radius else None
    return leg


def mark_missed_approach(procedure):
    """進入方式では、滑走路端（RWxx）より後ろの区間は進入復行。到着機の照合には使わない。"""
    passed = False
    for leg in procedure["legs"]:
        leg["missedApproach"] = passed
        if leg["fix"] and leg["fix"].startswith("RW"):
            passed = True


# ---------------------------------------------------------------------------
# 表のない IAP（ILS・LOC・LDA・VOR・多くの RNP）
# ---------------------------------------------------------------------------

def extract_role_approaches(doc, icao, locate, runway_ends):
    """チャートの「CREAM(IAF)」「APOLO(FAF)」のような役割つきのフィックスで進入経路を組み立てる。

    骨格は IAF → IF → FAF → MAPt（なければ滑走路端）。RNP のチャートには区間ごとに
    「4.5 252° (244.0°T)」のような距離と真方位の注記があるので、それと一致するフィックスの組を
    区間として認め、骨格の間にある旋回点を補う。注記がなければ骨格を直線で結ぶ。
    """
    approaches, seen = [], set()
    for page in doc:
        text = page.get_text()
        if not re.search(r"AD\s?2\.24-IAC", text) or any(w[4] == "Serial" for w in page.get_text("words")):
            continue
        roles = collections.defaultdict(list)
        # 役割ラベル自体が文字コードのずれで化けていることがあるので、戻した文字列からも拾う。
        # 戻す処理は化けていない部分を壊すが、座標の分かる名前だけを使うので誤りは混ざらない
        for name, role in ROLE_LABEL.findall(text) + ROLE_LABEL.findall(decode_shifted(text)):
            if name not in roles[role] and locate(name)[0]:
                roles[role].append(name)
        intermediate = next(iter(roles["IF"]), None)
        # LDA には名前つきの FAF がないことがある。その場合は IF を最終進入の起点にする
        faf = next(iter(roles["FAF"] + roles["FAP"]), None) or intermediate
        if not faf:
            continue

        flat = re.sub(r"\s+", " ", text)
        title = approach_title(page, flat)
        runway = runway_for(title, locate(faf)[0], runway_ends)
        final = next(iter(roles["MAPt"]), None) or (runway and runway["fix"])
        if not final:
            continue
        segments = annotated_segments(flat, locate, locate(faf)[0])
        starts = roles["IAF"] or [intermediate or faf]
        role_of = {n: r for r in ("IAF", "IF", "FAF", "FAP", "MAPt") for n in roles[r]}

        for start in starts:
            fixes, used_notes = [start], False
            for target in (intermediate, faf, final):
                if target and fixes[-1] != target:
                    step = follow(segments, fixes[-1], target)
                    used_notes |= len(step) > 1
                    fixes += step
            key = (title, tuple(fixes))
            if key in seen:
                continue
            seen.add(key)
            approaches.append({
                "airport": icao, "kind": "IAP",
                "name": title or (runway and f"(名称不明) RWY{runway['fix'][2:]}"),
                "section": f"{start} から" if len(starts) > 1 else None,
                "page": page.number + 1,
                "method": "roles+notes" if used_notes else "roles",
                "legs": [{"seq": f"{i + 1:03d}", "pathTerminator": None, "fix": n, "role": role_of.get(n)}
                         for i, n in enumerate(fixes)],
            })
    return approaches


def approach_title(page, flat):
    """チャート右上の名称（例: "ILS Z RWY34L"）。文字コードがずれて化けていれば戻してから探す。

    化けた部分は別のスパンに分かれるので、戻すと "LOC Z R WY34L" のように空白が挟まる。
    """
    for y, text in page_lines(page):
        if y < page.rect.height * 0.25:
            decoded = re.sub(r"R ?W ?Y ?(\d) ?(\d) ?([LRC]?)", r"RWY\1\2\3", re.sub(r" +", " ", decode_shifted(text)))
            for candidate in (text, decoded):
                if re.fullmatch(APPROACH_TITLE, candidate):
                    return candidate
    match = re.search(APPROACH_TITLE, flat)
    return match.group(0) if match else None


def runway_for(title, faf_point, runway_ends):
    """名称の RWYxx から滑走路端を決める。名称が取れなければ、FAF から滑走路の向きに並ぶ滑走路端を選ぶ。"""
    match = title and re.search(r"RWY ?(\d{2}[LRC]?)", title)
    if match and match.group(1) in runway_ends:
        return runway_ends[match.group(1)]
    aligned = [(heading_diff(bearing(faf_point, end["point"]), end["heading"]), end)
               for end in runway_ends.values() if km(faf_point, end["point"]) / NM < 15]
    aligned = [a for a in aligned if a[0] < 15]
    return min(aligned, key=lambda a: a[0])[1] if aligned else None


def annotated_segments(flat, locate, near):
    """「距離 磁方位 (真方位T)」の注記ごとに、距離と真方位が一致するフィックスの組を探す。"""
    notes = [(float(d), float(t)) for d, _, t in SEGMENT_NOTE.findall(flat)]
    if not notes:
        return {}
    points = {}
    for name in set(re.findall(rf"\b{FIX}\b", flat)):
        point = locate(name)[0]
        if point and km(point, near) < 100:
            points[name] = point
    segments = {}
    for distance, course in notes:
        best = None
        for a, pa in points.items():
            for b, pb in points.items():
                if a == b:
                    continue
                distance_error = abs(km(pa, pb) / NM - distance)
                course_error = heading_diff(bearing(pa, pb), course)
                if distance_error <= 0.15 and course_error <= 1.5:
                    error = distance_error / 0.15 + course_error / 1.5
                    if best is None or error < best[0]:
                        best = (error, a, b)
        if best:
            segments.setdefault(best[1], best[2])
    return segments


def follow(segments, start, target):
    """注記で確かめた区間をたどって start から target へ進む。たどり着けなければ直線で結ぶ。"""
    path, current = [], start
    while current != target and current in segments and segments[current] not in path and len(path) < 12:
        current = segments[current]
        path.append(current)
    return path if current == target else [target]


# ---------------------------------------------------------------------------
# 座標付けと、滑走路まわりの補完
# ---------------------------------------------------------------------------

def resolve(procedures, locate):
    """区間のウェイポイント名（と RF の中心点）に座標を付ける。"""
    by_source, unresolved = collections.Counter(), collections.Counter()
    for procedure in procedures:
        for leg in procedure["legs"]:
            if leg.get("centerFix"):
                leg["center"] = locate(leg["centerFix"])[0]
            if not leg["fix"]:
                continue
            point, source = locate(leg["fix"])
            if point:
                leg["lat"], leg["lon"], leg["source"] = point[0], point[1], source
                by_source[source] += 1
            else:
                unresolved[leg["fix"]] += 1
    return by_source, unresolved


def runway_leg(seq, end, synthetic):
    return {"seq": seq, "pathTerminator": None, "fix": end["fix"],
            "lat": end["point"][0], "lon": end["point"][1], "synthetic": synthetic}


def add_runway_geometry(procedures, runway_ends):
    """表に座標のない区間を、滑走路の位置から補う。補った区間には "synthetic" を付ける。

    - SID: 最初の区間は「滑走路の向きで一定高度まで上昇（VA）」でウェイポイントがないので、
      滑走路（離陸する端 → 反対側の端）を先頭に足す。区分が "RWY34L/RWY34R" のように
      複数の滑走路をまとめている場合は、滑走路ごとの手順に分ける。
    - IAP: LDA や VOR のように最終進入が滑走路の向きからずれている場合、最後に目視で滑走路に
      正対するので、滑走路端の手前に延長線上の点を足す。
    """
    result, split, offset = [], 0, []
    for procedure in procedures:
        runways = re.findall(r"\d{2}[LRC]?", procedure["section"] or "") if procedure["kind"] == "SID" else []
        runways = [r for r in runways if r in runway_ends]
        if runways:
            split += len(runways) - 1
            for runway in runways:
                end = runway_ends[runway]
                prefix = [runway_leg("RWY", end, "runway")]
                if end["opposite"] in runway_ends:
                    prefix.append(runway_leg("DER", runway_ends[end["opposite"]], "runway"))
                result.append({**procedure, "section": f"RWY{runway}",
                               "legs": prefix + [dict(leg) for leg in procedure["legs"]]})
            continue

        if procedure["kind"] == "IAP":
            legs = [g for g in procedure["legs"] if "lat" in g and not g.get("missedApproach")]
            end = next((e for e in runway_ends.values() if legs and e["fix"] == legs[-1]["fix"]), None)
            if end and len(legs) >= 2:
                diff = heading_diff(bearing((legs[-2]["lat"], legs[-2]["lon"]), end["point"]), end["heading"])
                if diff > OFFSET_FINAL_DEG:
                    point = destination(end["point"], end["heading"] + 180, VISUAL_SEGMENT_NM * NM)
                    procedure["legs"].insert(procedure["legs"].index(legs[-1]), {
                        "seq": "VIS", "pathTerminator": None, "fix": None,
                        "lat": point[0], "lon": point[1], "synthetic": "centerline"})
                    offset.append(f"{procedure['name']}({diff:.0f}°)")
        result.append(procedure)
    return result, split, offset


def report_approaches(procedures, runway_ends):
    """ILS/LOC の最終進入は滑走路の向きと一致するはずなので、抽出結果の検証に使う。"""
    headings = {end["fix"]: end["heading"] for end in runway_ends.values()}
    for p in (p for p in procedures if p["kind"] == "IAP"):
        legs = [g for g in p["legs"] if "lat" in g and not g.get("missedApproach") and not g.get("synthetic")]
        check = ""
        if len(legs) >= 2 and legs[-1]["fix"] in headings:
            diff = heading_diff(bearing((legs[-2]["lat"], legs[-2]["lon"]), (legs[-1]["lat"], legs[-1]["lon"])),
                                headings[legs[-1]["fix"]])
            check = f"最終進入と滑走路の向きの差 {diff:.1f}°"
        route = " → ".join(g["fix"] + (f"({g['role']})" if g.get("role") else "") for g in p["legs"]
                           if g["fix"] and not g.get("missedApproach"))
        print(f"    p{p['page']:<3} {p['method']:<11} {str(p['name']):<22} {route:<70} {check}")


def main():
    sys.stdout.reconfigure(encoding="utf-8")
    pymupdf.TOOLS.mupdf_display_errors(False)
    parser = argparse.ArgumentParser(description="AIP の PDF から SID/STAR/IAP の手順データを作る")
    parser.add_argument("--enr", required=True, type=Path, help="ENR の PDF")
    parser.add_argument("--ad2", required=True, nargs="+", type=Path, help="空港ごとの AD2 の PDF（ファイル名の先頭4文字を ICAO コードとみなす）")
    parser.add_argument("--runways", required=True, type=Path, help="OurAirports の runways.csv（滑走路端の位置と向き）")
    parser.add_argument("--out", required=True, type=Path)
    args = parser.parse_args()

    enr = pymupdf.open(args.enr)
    significant_points, mismatched = extract_significant_points(enr)
    navaids = extract_navaids(enr)
    print(f"ENR 4.3: {len(significant_points)} 点（名前と座標の数が合わず、位置で対応づけたページ {len(mismatched)}）")
    print(f"ENR 4.1: {len(navaids)} 局")

    all_procedures = []
    for path in args.ad2:
        icao = path.name[:4].upper()
        doc = pymupdf.open(path)
        terminal, conflicts = extract_terminal_waypoints(doc)
        runway_ends = load_runway_ends(args.runways, icao)
        runway_fixes = {end["fix"]: end["point"] for end in runway_ends.values()}
        center = [sum(p[0] for p in runway_fixes.values()) / len(runway_fixes),
                  sum(p[1] for p in runway_fixes.values()) / len(runway_fixes)]

        shared = [n for n in terminal if n in significant_points]
        distances = sorted(km(terminal[n], significant_points[n]) * 1000 for n in shared)
        far = [n for n in shared if km(terminal[n], significant_points[n]) > 0.1]
        median = f"{distances[len(distances) // 2]:.1f}m" if distances else "-"
        print(f"[{icao}] 空港ウェイポイント {len(terminal)} 点 / ページ間の食い違い {len(conflicts)} 件 {conflicts[:5]}"
              f" / ENR 4.3 と共通 {len(shared)} 点（差の中央値 {median}、100m 超: {far}）")

        locate = make_locator([("terminal", terminal), ("runway", runway_fixes),
                               ("enr4.3", significant_points), ("enr4.1", navaids)], center)
        procedures = extract_procedures(doc, icao)
        table_approaches = {p["name"] for p in procedures if p["kind"] == "IAP"}
        procedures += [a for a in extract_role_approaches(doc, icao, locate, runway_ends)
                       if a["name"] not in table_approaches]
        for procedure in procedures:
            if procedure["kind"] == "IAP":
                mark_missed_approach(procedure)
        by_source, unresolved = resolve(procedures, locate)
        procedures, split, offset = add_runway_geometry(procedures, runway_ends)

        resolved = sum(by_source.values())
        total = resolved + sum(unresolved.values())
        kinds = collections.Counter(p["kind"] for p in procedures)
        methods = collections.Counter(p["method"] for p in procedures if p["kind"] == "IAP")
        names = {(p["kind"], p["name"]) for p in procedures}
        print(f"[{icao}] 手順 {len(procedures)} 本 {dict(kinds)} / 経路名 {len(names)} 種"
              f" / 名前不明 {sum(1 for p in procedures if not p['name'] or p['name'].startswith('(名称不明)'))} 本"
              f" / IAP の作り方 {dict(methods)}")
        print(f"[{icao}] ウェイポイント {total} 個中 {resolved} 個を座標化（{resolved / total:.1%}）"
              f" 出典 {dict(by_source)} / 未解決 {dict(unresolved)}")
        print(f"[{icao}] 滑走路の補完: SID を滑走路ごとに分けて +{split} 本 / 最終進入がずれている IAP に正対区間を追加 {offset}")
        report_approaches(procedures, runway_ends)
        all_procedures += procedures

    for i, procedure in enumerate(all_procedures):
        procedure["id"] = f"{procedure['airport']}-{procedure['kind']}-{i:04d}"
        procedure["reviewed"] = False  # 人手で確認するまでは照合に使わない（docs/spec.md 10.3）

    args.out.parent.mkdir(parents=True, exist_ok=True)
    with open(args.out, "w", encoding="utf-8") as f:
        json.dump({
            "generatedAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "sources": [args.enr.name] + [p.name for p in args.ad2],
            "procedures": all_procedures,
        }, f, ensure_ascii=False, indent=1)
    print(f"→ {args.out}")


if __name__ == "__main__":
    main()
