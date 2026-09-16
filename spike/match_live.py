"""AIP から作った手順データと、実際に飛んでいる機体の航跡を照合する（F-10 レベル2 の検証用）。

    python spike/match_live.py --procedures data/aip/procedures.json [--tracks-file tracks.json]

adsb.lol から 10 秒おきに位置を取って短い航跡を作り、adsbdb の出発地・到着地で候補の空港を絞ってから、
航跡と手順の折れ線との距離・方位差で採点する。

--tracks-file を付けると、初回は取得した航跡と出発地・到着地を保存し、2 回目以降はそれを読み込む。
手順データを直したときに、同じ航跡で前後を比べるために使う。
"""

import argparse
import collections
import json
import math
import re
import sys
import time
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

HEADERS = {"User-Agent": "flightboard-spike/0.1"}
MAX_MEAN_DISTANCE_KM = 1.5
MAX_MEAN_HEADING_DIFF = 25
HEADING_DIFF_PER_KM = 15  # 採点では方位差 15° を距離 1km と同じ重みで扱う
AIRLINE_CALLSIGN = re.compile(r"[A-Z]{3}\d{1,4}[A-Z]{0,2}")
DEPARTURE_KINDS = ("SID", "TRANS")


def get_json(url):
    with urllib.request.urlopen(urllib.request.Request(url, headers=HEADERS), timeout=30) as response:
        return json.load(response)


def fetch_tracks(lat, lon, radius_nm, samples, interval):
    tracks, latest = collections.defaultdict(list), {}
    for i in range(samples):
        for aircraft in get_json(f"https://api.adsb.lol/v2/point/{lat}/{lon}/{radius_nm}")["ac"]:
            if aircraft.get("lat") is None or aircraft.get("track") is None or aircraft.get("alt_baro") == "ground":
                continue
            point = (aircraft["lat"], aircraft["lon"], aircraft["track"])
            if not tracks[aircraft["hex"]] or tracks[aircraft["hex"]][-1][:2] != point[:2]:
                tracks[aircraft["hex"]].append(point)
            latest[aircraft["hex"]] = aircraft
        if i < samples - 1:
            time.sleep(interval)
    return tracks, latest


def lookup_route(callsign):
    try:
        route = get_json(f"https://api.adsbdb.com/v0/callsign/{callsign}")["response"]["flightroute"]
    except Exception:
        return None
    return {
        "origin": route["origin"]["icao_code"],
        "destination": route["destination"]["icao_code"],
        "label": f"{route['origin']['iata_code']}→{route['destination']['iata_code']}",
    }


def is_candidate(aircraft, max_altitude):
    return (AIRLINE_CALLSIGN.fullmatch((aircraft.get("flight") or "").strip())
            and isinstance(aircraft.get("alt_baro"), (int, float)) and aircraft["alt_baro"] < max_altitude
            and (aircraft.get("gs") or 0) > 120 and not (aircraft.get("dbFlags", 0) & 1))


def capture(args):
    """航跡と、照合対象の機体の出発地・到着地を集める。--tracks-file があれば保存・再利用する。"""
    path = Path(args.tracks_file) if args.tracks_file else None
    if path and path.exists():
        data = json.load(open(path, encoding="utf-8"))
        print(f"保存済みの航跡を使う: {path}（取得 {data['capturedAt']}）")
        return data["tracks"], data["latest"], data["routes"]

    tracks, latest = fetch_tracks(args.lat, args.lon, args.radius_nm, args.samples, args.interval)
    routes = {}
    for hex_code, aircraft in latest.items():
        if is_candidate(aircraft, args.max_altitude):
            routes[hex_code] = lookup_route(aircraft["flight"].strip())
            time.sleep(0.12)
    if path:
        with open(path, "w", encoding="utf-8") as f:
            json.dump({"capturedAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
                       "tracks": tracks, "latest": latest, "routes": routes}, f, ensure_ascii=False)
        print(f"航跡を保存: {path}")
    return tracks, latest, routes


class LocalProjection:
    """数十 km の範囲なので、正距円筒で平面に近似する。"""

    def __init__(self, lat, lon):
        self.lat, self.lon = lat, lon
        self.kx = 111.32 * math.cos(math.radians(lat))

    def __call__(self, lat, lon):
        return (lon - self.lon) * self.kx, (lat - self.lat) * 110.57


def build_polyline(procedure, project):
    """区間を平面の折れ線にする。RF（円弧）は中心と旋回方向から補間し、進入復行の区間は含めない。"""
    points = []
    for leg in procedure["legs"]:
        if leg.get("missedApproach") or "lat" not in leg:
            continue
        here = project(leg["lat"], leg["lon"])
        if leg.get("pathTerminator") == "RF" and points and leg.get("center"):
            points += arc(points[-1], here, project(*leg["center"]), leg.get("turn"))
        points.append(here)
    return points


def arc(start, end, center, turn, steps=8):
    a0 = math.atan2(start[1] - center[1], start[0] - center[0])
    a1 = math.atan2(end[1] - center[1], end[0] - center[0])
    radius = (math.dist(start, center) + math.dist(end, center)) / 2
    # x=東・y=北 の平面では、左旋回は角度が増える向き（反時計回り）
    sweep = (a1 - a0) % (2 * math.pi) if turn == "L" else -((a0 - a1) % (2 * math.pi))
    return [(center[0] + radius * math.cos(a0 + sweep * i / steps), center[1] + radius * math.sin(a0 + sweep * i / steps))
            for i in range(1, steps)]


def distance_and_bearing(point, a, b):
    """点から線分 ab までの距離（km）と、線分の方位（度）。"""
    dx, dy = b[0] - a[0], b[1] - a[1]
    length2 = dx * dx + dy * dy
    t = 0 if length2 == 0 else max(0, min(1, ((point[0] - a[0]) * dx + (point[1] - a[1]) * dy) / length2))
    distance = math.hypot(point[0] - a[0] - t * dx, point[1] - a[1] - t * dy)
    return distance, (math.degrees(math.atan2(dx, dy)) + 360) % 360


def heading_diff(a, b):
    return abs((a - b + 540) % 360 - 180)


def score(track, polyline, project):
    distances, diffs = [], []
    for lat, lon, heading in track:
        point = project(lat, lon)
        d, bearing = min((distance_and_bearing(point, polyline[i], polyline[i + 1]) for i in range(len(polyline) - 1)),
                         key=lambda x: x[0])
        distances.append(d)
        diffs.append(heading_diff(heading, bearing))
    return sum(distances) / len(distances), sum(diffs) / len(diffs)


def main():
    sys.stdout.reconfigure(encoding="utf-8")
    parser = argparse.ArgumentParser(description="手順データと実機の航跡を照合する")
    parser.add_argument("--procedures", required=True)
    parser.add_argument("--tracks-file", help="航跡の保存先（あれば読み込む）")
    parser.add_argument("--lat", type=float, default=35.86)  # 千葉県流山市周辺（仕様 6.5 の利用地点）
    parser.add_argument("--lon", type=float, default=139.90)
    parser.add_argument("--radius-nm", type=int, default=60)
    parser.add_argument("--samples", type=int, default=3)
    parser.add_argument("--interval", type=int, default=10)
    parser.add_argument("--max-altitude", type=int, default=20000)
    args = parser.parse_args()

    project = LocalProjection(args.lat, args.lon)
    procedures = json.load(open(args.procedures, encoding="utf-8"))["procedures"]
    polylines = [(p, points) for p in procedures if len(points := build_polyline(p, project)) >= 2]
    airports = {p["airport"] for p in procedures}
    print(f"照合に使う手順: {dict(collections.Counter(p['kind'] for p, _ in polylines))}")

    tracks, latest, routes = capture(args)
    candidates = [h for h in routes if is_candidate(latest[h], args.max_altitude)]

    relevant, matched, unmatched = 0, [], []
    for hex_code in candidates:
        aircraft, route = latest[hex_code], routes[hex_code]
        # 出発地・到着地が対象空港でない機体（通過機など）は照合しない
        if route and route["origin"] not in airports and route["destination"] not in airports:
            continue
        relevant += 1
        vertical_rate = aircraft.get("baro_rate") or aircraft.get("geom_rate") or 0

        scored = []
        for procedure, polyline in polylines:
            departure = procedure["kind"] in DEPARTURE_KINDS
            if route and procedure["airport"] != (route["origin"] if departure else route["destination"]):
                continue
            if (vertical_rate > 300 and not departure) or (vertical_rate < -300 and departure):
                continue
            mean_distance, mean_diff = score(tracks[hex_code], polyline, project)
            scored.append((mean_distance + mean_diff / HEADING_DIFF_PER_KM, mean_distance, mean_diff, procedure))
        scored.sort(key=lambda s: s[0])
        hits = [s for s in scored if s[1] < MAX_MEAN_DISTANCE_KM and s[2] < MAX_MEAN_HEADING_DIFF]
        (matched if hits else unmatched).append((aircraft, route, vertical_rate, hits or scored[:1]))

    print(f"航跡 {len(tracks)} 機 / 航空会社便・{args.max_altitude:,}ft 未満 {len(candidates)} 機"
          f" / うち対象空港（{', '.join(sorted(airports))}）発着 {relevant} 機 / 手順と一致 {len(matched)} 機"
          f"（最良候補の種類 {dict(collections.Counter(m[3][0][3]['kind'] for m in matched))}）\n")
    for aircraft, route, vertical_rate, hits in sorted(matched, key=lambda m: int(m[0]["alt_baro"])):
        best = hits[0]
        procedure = best[3]
        names = sorted({h[3]["name"] or "(名称不明)" for h in hits})
        others = f"  ※候補 {len(names)}: {', '.join(names[:4])}" if len(names) > 1 else ""
        print(f"  {aircraft['flight'].strip():<8} {int(aircraft['alt_baro']):>6}ft {int(vertical_rate):>+6}fpm"
              f"  {procedure['airport']} {procedure['kind']:<5} {procedure['name'] or '(名称不明)':<24}"
              f" [{procedure['section'] or '':<14}] ズレ {best[1]:.2f}km 方位差 {best[2]:.0f}°"
              f"  {route['label'] if route else 'ルート不明'}{others}")

    print("\n一致しなかった機体（最も近い手順までの距離）:")
    for aircraft, route, vertical_rate, nearest in sorted(unmatched, key=lambda m: int(m[0]["alt_baro"])):
        detail = (f"{nearest[0][3]['kind']} {nearest[0][3]['name']} まで {nearest[0][1]:.1f}km・方位差 {nearest[0][2]:.0f}°"
                  if nearest else "条件に合う手順なし")
        print(f"  {aircraft['flight'].strip():<8} {int(aircraft['alt_baro']):>6}ft {int(vertical_rate):>+6}fpm"
              f"  {route['label'] if route else 'ルート不明':<9} {detail}")


if __name__ == "__main__":
    main()
