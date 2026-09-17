import { describe, expect, it } from "vitest";
import { importRunwayEnds, renderRunwaysModule } from "./importRunways.ts";

// 列名は OurAirports の runways.csv（spike/aip_import.py:241-256 の実績）に合わせる。
// 値は実データの羽田 B 滑走路（04/22）と D 滑走路（05/23）の行から採った。
// このテストはネットワークに接続しない（CSV は文字列として渡す）。
const COLUMNS = [
  "id", "airport_ident", "length_ft", "closed",
  "le_ident", "le_latitude_deg", "le_longitude_deg", "le_heading_degT",
  "he_ident", "he_latitude_deg", "he_longitude_deg", "he_heading_degT",
];
// le_heading_degT 35° は座標から計算した真方位 34.9° とほぼ一致する行
const ROW_04_22 = ["237196", "RJTT", "8202", "0", "04", "35.549015", "139.761274", "35", "22", "35.567459", "139.777114", "215"];
// le_heading_degT 57° は座標から計算した真方位 42.4° と 14.6° 食い違う行（AC-P2-04b）
const ROW_05_23 = ["308751", "RJTT", "8202", "0", "05", "35.524001", "139.803469", "57", "23", "35.540598", "139.822125", "223"];
const ROW_RJAA = ["237142", "RJAA", "13123", "0", "16R", "35.774398", "140.367996", "150", "34L", "35.743301", "140.391006", "330"];
// 実データの成田 B 滑走路。端の間は 2.168km なのに length_ft は 8,202ft（2,500m）＝ -13.3%（AC-P2-03）
const ROW_RJAA_16L_34R = [
  "237143", "RJAA", "8202", "0",
  "16L", "35.80270004272461", "140.3800048828125", "150",
  "34R", "35.78580093383789", "140.39199829101562", "330",
];
// **合成データ**（実在の滑走路ではない）。真北へ 2.224km 伸びる滑走路に指示子 02/20（磁方位 20°/200°）と
// 公示 6,562ft（2.000km）を当てた行。長さは +11.2% で不一致、指示子と真方位の食い違いは 12.0° で
// AC-P2-02 の許容（7°）を超える。実データにはこの組み合わせが無いので、分岐を試すために作った
const ROW_SYNTHETIC_OVER_7DEG = ["999999", "RJTT", "6562", "0", "02", "35.5", "139.8", "0", "20", "35.52", "139.8", "180"];

/** 全フィールドを引用符で囲んだ CSV を組み立てる */
function csv(...rows: readonly (readonly string[])[]): string {
  return rows.map((cells) => cells.map((cell) => `"${cell}"`).join(",")).join("\n");
}

describe("AC-P2-04: importRunwayEnds の取り込み", () => {
  it("1 行から対向する 2 端を作る（座標・対向端の識別子・公示滑走路長）", () => {
    const { ends, warnings } = importRunwayEnds(csv(COLUMNS, ROW_04_22), ["RJTT"]);
    expect(ends).toEqual([
      { icao: "RJTT", ident: "04", lat: 35.549015, lon: 139.761274, oppositeIdent: "22", lengthFt: 8202 },
      { icao: "RJTT", ident: "22", lat: 35.567459, lon: 139.777114, oppositeIdent: "04", lengthFt: 8202 },
    ]);
    expect(warnings).toEqual([]);
  });

  it("真方位は持たせない（自端 → 対向端の座標から計算するため）", () => {
    const { ends } = importRunwayEnds(csv(COLUMNS, ROW_04_22), ["RJTT"]);
    for (const end of ends) {
      expect(end).not.toHaveProperty("headingDegT");
      expect(Object.keys(end).sort()).toEqual(["icao", "ident", "lat", "lengthFt", "lon", "oppositeIdent"].sort());
    }
  });

  it("対象 ICAO で絞り込む（他の空港の行は捨てる）", () => {
    const { ends } = importRunwayEnds(csv(COLUMNS, ROW_04_22, ROW_RJAA), ["RJTT"]);
    expect(ends.map((end) => `${end.icao} ${end.ident}`)).toEqual(["RJTT 04", "RJTT 22"]);
  });

  it("並びは指定した ICAO の順、同じ空港では識別子の昇順", () => {
    const { ends } = importRunwayEnds(csv(COLUMNS, ROW_RJAA, ROW_05_23, ROW_04_22), ["RJTT", "RJAA"]);
    expect(ends.map((end) => `${end.icao} ${end.ident}`)).toEqual([
      "RJTT 04", "RJTT 05", "RJTT 22", "RJTT 23", "RJAA 16R", "RJAA 34L",
    ]);
  });

  it("列はヘッダ行から引く（列の並びが違っても・知らない列があってもよい）", () => {
    const shuffled = [
      '"he_ident","le_longitude_deg","surface","he_longitude_deg","airport_ident","le_ident","length_ft","he_latitude_deg","le_latitude_deg"',
      '"22","139.761274","ASP","139.777114","RJTT","04","8202","35.567459","35.549015"',
    ].join("\n");
    const { ends } = importRunwayEnds(shuffled, ["RJTT"]);
    expect(ends.map((end) => end.ident)).toEqual(["04", "22"]);
    expect(ends[0]?.lat).toBe(35.549015);
  });

  it("引用符付きフィールド（区切りの , と \"\" を含む）を読める", () => {
    const quoted = [
      '"id","airport_ident","surface","length_ft","le_ident","le_latitude_deg","le_longitude_deg","he_ident","he_latitude_deg","he_longitude_deg"',
      '1,"RJTT","ASP, PEM ""grooved""",8202,"04",35.549015,139.761274,"22",35.567459,139.777114',
    ].join("\n");
    const { ends } = importRunwayEnds(quoted, ["RJTT"]);
    expect(ends.map((end) => end.ident)).toEqual(["04", "22"]);
    expect(ends[1]?.lengthFt).toBe(8202);
  });

  it("CRLF と末尾の空行を読み飛ばす", () => {
    const crlf = `${csv(COLUMNS, ROW_04_22).replace(/\n/g, "\r\n")}\r\n\r\n`;
    const { ends } = importRunwayEnds(crlf, ["RJTT"]);
    expect(ends.map((end) => end.ident)).toEqual(["04", "22"]);
  });

  it("座標が空の端は取り込まない。対向端の座標が無いと真方位を計算できないので、その滑走路は両端とも落とす", () => {
    const missing = [...ROW_04_22];
    missing[9] = ""; // he_latitude_deg
    missing[10] = ""; // he_longitude_deg
    const { ends, warnings } = importRunwayEnds(csv(COLUMNS, missing, ROW_05_23), ["RJTT"]);
    expect(ends.map((end) => end.ident)).toEqual(["05", "23"]);
    expect(warnings[0]).toBe("RJTT 04/22: 座標か識別子が空の端があるため、この滑走路を取り込まなかった");
  });

  it("closed 列が立っている滑走路は取り込まない", () => {
    const closed = [...ROW_04_22];
    closed[3] = "1";
    const { ends } = importRunwayEnds(csv(COLUMNS, closed, ROW_05_23), ["RJTT"]);
    expect(ends.map((end) => end.ident)).toEqual(["05", "23"]);
  });

  it("closed 列が無ければ「閉鎖でない」とみなす", () => {
    const columns = COLUMNS.filter((name) => name !== "closed");
    const row = ROW_04_22.filter((_cell, index) => COLUMNS[index] !== "closed");
    const { ends } = importRunwayEnds(csv(columns, row), ["RJTT"]);
    expect(ends.map((end) => end.ident)).toEqual(["04", "22"]);
  });

  it("length_ft 列が無い・空なら lengthFt を持たせない（滑走路長の検査から外れる）", () => {
    const columns = COLUMNS.filter((name) => name !== "length_ft");
    const row = ROW_04_22.filter((_cell, index) => COLUMNS[index] !== "length_ft");
    expect(importRunwayEnds(csv(columns, row), ["RJTT"]).ends[0]).not.toHaveProperty("lengthFt");

    const empty = [...ROW_04_22];
    empty[2] = "";
    expect(importRunwayEnds(csv(COLUMNS, empty), ["RJTT"]).ends[0]).not.toHaveProperty("lengthFt");
  });

  it("必要な列が無ければ TypeError（どの列が無いかを言う）", () => {
    const columns = COLUMNS.filter((name) => name !== "he_latitude_deg");
    const row = ROW_04_22.filter((_cell, index) => COLUMNS[index] !== "he_latitude_deg");
    expect(() => importRunwayEnds(csv(columns, row), ["RJTT"])).toThrow(TypeError);
    expect(() => importRunwayEnds(csv(columns, row), ["RJTT"])).toThrow(/he_latitude_deg/);
  });

  it("空の CSV は TypeError", () => {
    expect(() => importRunwayEnds("", ["RJTT"])).toThrow(TypeError);
  });

  it("同じ空港・同じ識別子の端を作る行は、先に現れた行を採り、後の行は警告して捨てる", () => {
    // 同じ 04/22 を座標だけ変えてもう 1 行置く（OurAirports 側の重複行を想定）
    const again = [...ROW_04_22];
    again[0] = "999999";
    again[5] = "35.5";
    const { ends, warnings } = importRunwayEnds(csv(COLUMNS, ROW_04_22, again, ROW_RJAA), ["RJTT", "RJAA"]);
    expect(ends.map((end) => `${end.icao} ${end.ident} ${end.lat}`)).toEqual([
      "RJTT 04 35.549015", "RJTT 22 35.567459", "RJAA 16R 35.774398", "RJAA 34L 35.743301",
    ]);
    expect(warnings).toEqual([
      "RJTT 04/22: 識別子 04・22 の端が重複しているため、この行を取り込まなかった" +
        "（同じ空港・同じ識別子は先に現れた行を採る）",
    ]);
  });

  it("重複した行は片端だけ落とさず両端まとめて捨てる（対向端の相互参照を壊さないため）", () => {
    // 04 だけが既にある行と重なるケース。22 側も取り込まない
    const overlapping = [...ROW_04_22];
    overlapping[8] = "21";
    overlapping[9] = "35.56";
    const { ends, warnings } = importRunwayEnds(csv(COLUMNS, ROW_04_22, overlapping), ["RJTT"]);
    expect(ends.map((end) => end.ident)).toEqual(["04", "22"]);
    expect(warnings[0]).toBe(
      "RJTT 04/21: 識別子 04 の端が重複しているため、この行を取り込まなかった（同じ空港・同じ識別子は先に現れた行を採る）",
    );
  });

  it("同じ行の両端が同じ識別子でも重複として捨てる", () => {
    const broken = [...ROW_04_22];
    broken[8] = "04";
    const { ends, warnings } = importRunwayEnds(csv(COLUMNS, broken), ["RJTT"]);
    expect(ends).toEqual([]);
    expect(warnings[0]).toContain("識別子 04 の端が重複している");
  });

  it("別の空港の同じ識別子は重複ではない", () => {
    const { ends, warnings } = importRunwayEnds(csv(COLUMNS, ROW_RJAA, ROW_RJAA.map(
      (cell, index) => (COLUMNS[index] === "airport_ident" ? "RJTT" : cell),
    )), ["RJTT", "RJAA"]);
    expect(ends.map((end) => `${end.icao} ${end.ident}`)).toEqual([
      "RJTT 16R", "RJTT 34L", "RJAA 16R", "RJAA 34L",
    ]);
    expect(warnings).toEqual([]);
  });

  it("対象空港の行が無ければ空（例外にはしない）", () => {
    expect(importRunwayEnds(csv(COLUMNS, ROW_04_22), ["RJAA"])).toEqual({
      ends: [],
      warnings: [],
      lengthMismatches: [],
    });
  });
});

describe("AC-P2-04b: CSV の真方位と、座標から計算した真方位の食い違い", () => {
  it("差が 1° 以内の行（04/22: CSV 35° / 座標 34.9°）では警告を出さない", () => {
    expect(importRunwayEnds(csv(COLUMNS, ROW_04_22), ["RJTT"]).warnings).toEqual([]);
  });

  it("差が 1° を超える行（05: CSV 57° / 座標 42.4°）は警告を出し、座標側を採る", () => {
    const { ends, warnings } = importRunwayEnds(csv(COLUMNS, ROW_05_23), ["RJTT"]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toBe(
      "RJTT 05: CSV の真方位 57.0° と座標から計算した真方位 42.4° が 14.6° 食い違う（座標側を採った）",
    );
    // 拒否はしない。座標はそのまま入り、真方位は持たせない
    expect(ends).toEqual([
      { icao: "RJTT", ident: "05", lat: 35.524001, lon: 139.803469, oppositeIdent: "23", lengthFt: 8202 },
      { icao: "RJTT", ident: "23", lat: 35.540598, lon: 139.822125, oppositeIdent: "05", lengthFt: 8202 },
    ]);
  });

  it("一致する行と食い違う行が混ざっても、食い違った端の分だけ警告が出る", () => {
    const { ends, warnings } = importRunwayEnds(csv(COLUMNS, ROW_04_22, ROW_05_23), ["RJTT"]);
    expect(ends).toHaveLength(4);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("RJTT 05");
  });

  it("_heading_degT 列が無い・空なら比べない（警告も出ない）", () => {
    const columns = COLUMNS.filter((name) => !name.endsWith("_heading_degT"));
    const row = ROW_05_23.filter((_cell, index) => !COLUMNS[index]?.endsWith("_heading_degT"));
    expect(importRunwayEnds(csv(columns, row), ["RJTT"]).warnings).toEqual([]);

    const empty = [...ROW_05_23];
    empty[7] = "";
    expect(importRunwayEnds(csv(COLUMNS, empty), ["RJTT"]).warnings).toEqual([]);
  });

  it("359° と 1° のように 0° をまたぐ差でも小さい差として扱う", () => {
    const columns = ["airport_ident", "le_ident", "le_latitude_deg", "le_longitude_deg", "le_heading_degT", "he_ident", "he_latitude_deg", "he_longitude_deg", "he_heading_degT"];
    // 真北へ伸びる滑走路（真方位 0.0° / 180.0°）に CSV の 359.9° を当てる
    const row = ["RJTT", "36", "35.5", "139.8", "359.9", "18", "35.52", "139.8", "179.9"];
    expect(importRunwayEnds(csv(columns, row), ["RJTT"]).warnings).toEqual([]);
  });
});

describe("AC-P2-05: renderRunwaysModule が書き出すソース", () => {
  const ends = importRunwayEnds(csv(COLUMNS, ROW_04_22), ["RJTT"]).ends;
  const source = renderRunwaysModule(ends, { sourceName: "runways.csv", generatedAt: "2026-09-16" });

  it("出所（OurAirports・パブリックドメイン）と取り込み元・生成日を書く", () => {
    expect(source).toContain("OurAirports");
    expect(source).toContain("パブリックドメイン");
    expect(source).toContain("取り込み元: runways.csv");
    expect(source).toContain("生成日: 2026-09-16");
  });

  it("自動生成である旨と再生成コマンドを書く", () => {
    expect(source).toContain("このファイルは自動生成です");
    expect(source).toContain("npm run import-runways");
  });

  it("一次情報と突き合わせていないこと・真方位を座標から計算することを書く", () => {
    expect(source).toContain("AIP など一次情報との突き合わせはしていない");
    expect(source).toContain("真方位はデータに持たない");
  });

  it("滑走路端と runwayEndsFor を書き出す。磁気偏角の定数は書かない（手書きの airports.ts にある）", () => {
    expect(source).not.toContain("MAGNETIC_VARIATION_DEG = ");
    expect(source).toContain("磁気偏角（MAGNETIC_VARIATION_DEG）は人が決める設定値なので");
    expect(source).toContain("export function runwayEndsFor(icao: string): readonly RunwayEnd[] {");
    expect(source).toContain(
      '{ icao: "RJTT", ident: "04", lat: 35.549015, lon: 139.761274, oppositeIdent: "22", lengthFt: 8202 },',
    );
  });

  it("lengthFt が無い端では lengthFt を書かない", () => {
    const withoutLength = renderRunwaysModule(
      [{ icao: "RJTT", ident: "04", lat: 35.549015, lon: 139.761274, oppositeIdent: "22" }],
      { sourceName: "runways.csv", generatedAt: "2026-09-16" },
    );
    expect(withoutLength).toContain(
      '{ icao: "RJTT", ident: "04", lat: 35.549015, lon: 139.761274, oppositeIdent: "22" },',
    );
  });
});

describe("AC-P2-03: 取り込みが検出する「既知の不一致」", () => {
  it("端の間の距離が公示滑走路長の ±10% に収まっていれば記録しない", () => {
    expect(importRunwayEnds(csv(COLUMNS, ROW_04_22, ROW_RJAA), ["RJTT", "RJAA"]).lengthMismatches).toEqual([]);
  });

  it("±10% を外れた滑走路を、ずれの値と方位の食い違いつきで記録する（成田 16L/34R は -13.3%）", () => {
    const { lengthMismatches } = importRunwayEnds(csv(COLUMNS, ROW_RJAA_16L_34R), ["RJAA"]);
    expect(lengthMismatches).toEqual([
      {
        icao: "RJAA",
        ident: "16L",
        oppositeIdent: "34R",
        endsApartKm: 2.168,
        publishedKm: 2.5,
        deviation: -0.1327,
        identDeviationDeg: 1.9,
      },
    ]);
  });

  it("取り込みは止めない（端は両方とも入る）", () => {
    const { ends } = importRunwayEnds(csv(COLUMNS, ROW_RJAA_16L_34R), ["RJAA"]);
    expect(ends.map((end) => end.ident)).toEqual(["16L", "34R"]);
  });

  it("length_ft が無ければ検査しようがないので記録しない（AC-P2-03 の対象外）", () => {
    const columns = COLUMNS.filter((name) => name !== "length_ft");
    const row = ROW_RJAA_16L_34R.filter((_cell, index) => COLUMNS[index] !== "length_ft");
    expect(importRunwayEnds(csv(columns, row), ["RJAA"]).lengthMismatches).toEqual([]);
  });

  it("代表の端は識別子の昇順で先の方（RUNWAY_ENDS 側の数え方と揃える）", () => {
    // le/he を入れ替えた行でも 16L/34R の向きで記録される
    const swapped = [
      ROW_RJAA_16L_34R[0], ROW_RJAA_16L_34R[1], ROW_RJAA_16L_34R[2], ROW_RJAA_16L_34R[3],
      ...ROW_RJAA_16L_34R.slice(8, 12), ...ROW_RJAA_16L_34R.slice(4, 8),
    ] as string[];
    const { lengthMismatches } = importRunwayEnds(csv(COLUMNS, swapped), ["RJAA"]);
    expect(lengthMismatches.map((mismatch) => `${mismatch.ident}/${mismatch.oppositeIdent}`)).toEqual(["16L/34R"]);
  });
});

describe("AC-P2-05: 生成ソースに残す警告と既知の不一致", () => {
  const imported = importRunwayEnds(csv(COLUMNS, ROW_05_23, ROW_RJAA_16L_34R), ["RJTT", "RJAA"]);
  const source = renderRunwaysModule(imported.ends, {
    sourceName: "runways.csv",
    generatedAt: "2026-09-16",
    warnings: imported.warnings,
    lengthMismatches: imported.lengthMismatches,
  });

  it("取り込み時の警告をそのまま書く（実際に出た警告だけ。未実証の一般論を書かない）", () => {
    expect(source).toContain(
      "// 警告: RJTT 05: CSV の真方位 57.0° と座標から計算した真方位 42.4° が 14.6° 食い違う（座標側を採った）",
    );
    expect(source).not.toContain("10° 丸めの値が入っている行がある");
  });

  it("既知の不一致を 1 件 1 行で書く（テストが読み戻せる形）", () => {
    expect(source).toContain(
      "// 既知の不一致: RJAA 16L/34R — 端間 2.168km / 公示 2.500km（-13.3%、差 0.332km）",
    );
  });

  it("不一致について分かっている事実を書く（中心線方向のずれ・旧位置は不明）", () => {
    expect(source).toContain("食い違いは最大 1.9°");
    expect(source).toContain("AC-P2-02 の許容（7°）に収まっている");
    expect(source).toContain("滑走路中心線に沿った方向のずれ");
    expect(source).toContain("どちらの端が旧位置かは判別できていない");
  });

  it("どちらの端がずれたかは断定しない（座標から確かめていないので「片端だけ」と書かない）", () => {
    expect(source).toContain("片端または両端が中心線に沿ってずれた形。どちらかは不明");
    expect(source).not.toContain("片端だけが延長・移設された形");
  });

  it("距離のずれの影響を、docs/spec.md §10.2 が距離を使う箇所すべてについて書く", () => {
    // §10.2 は距離を evidence の表示だけでなく採点・許容ズレ・進入/出発の距離条件にも使う。
    // 0.332km なら採点 0.332 × 0.3 ≒ 0.1 点、許容ズレ 0.332 × 0.4 ≒ 0.13°
    expect(source).toContain("端の座標のずれは最大 0.33km");
    expect(source).toContain("採点（距離km × 0.3）・許容ズレ（20° − 距離km × 0.4）・進入/出発の距離条件");
    expect(source).toContain("採点 0.1 点・許容ズレ 0.13° 相当");
    expect(source).not.toContain("ずれることに限られる");
  });

  it("機械的に読める KNOWN_LENGTH_MISMATCHES も書き出す", () => {
    expect(source).toContain("export const KNOWN_LENGTH_MISMATCHES: readonly LengthMismatch[] = [");
    expect(source).toContain('{ icao: "RJAA", ident: "16L", oppositeIdent: "34R", endsApartKm: 2.168, ');
    expect(source).toContain("deviation: -0.1327, identDeviationDeg: 1.9 },");
  });

  it("警告も不一致も無ければ「なし」と書き、KNOWN_LENGTH_MISMATCHES は空になる", () => {
    const clean = renderRunwaysModule(importRunwayEnds(csv(COLUMNS, ROW_04_22), ["RJTT"]).ends, {
      sourceName: "runways.csv",
      generatedAt: "2026-09-16",
    });
    expect(clean).toContain("// 取り込み時の警告: なし");
    expect(clean).toContain("// 既知の不一致: なし");
    expect(clean).toContain("export const KNOWN_LENGTH_MISMATCHES: readonly LengthMismatch[] = [];");
  });
});

describe("AC-P2-05: 指示子との食い違いが AC-P2-02 の許容（7°）を超える不一致", () => {
  // 値を見ずに「許容に収まっている＝中心線は動いていない」と書くと、許容を超える不一致が出たときに
  // 「最大 12.0° で、7° に収まっている」という自己矛盾をファイルに書き出してしまう。その分岐の検査
  const imported = importRunwayEnds(csv(COLUMNS, ROW_SYNTHETIC_OVER_7DEG), ["RJTT"]);
  const source = renderRunwaysModule(imported.ends, {
    sourceName: "runways.csv",
    generatedAt: "2026-09-16",
    lengthMismatches: imported.lengthMismatches,
  });

  it("前提: この合成データは長さが +11.2% ずれ、指示子との食い違いが 12.0°（> 7°）になる", () => {
    expect(imported.lengthMismatches).toEqual([
      {
        icao: "RJTT",
        ident: "02",
        oppositeIdent: "20",
        endsApartKm: 2.224,
        publishedKm: 2,
        deviation: 0.1119,
        identDeviationDeg: 12,
      },
    ]);
  });

  it("「許容に収まっている」「中心線に沿ったずれ」「方位には影響しない」とは書かない", () => {
    expect(source).toContain("食い違いは最大 12.0°");
    expect(source).not.toContain("AC-P2-02 の許容（7°）に収まっている");
    expect(source).not.toContain("滑走路中心線に沿った方向のずれ");
    expect(source).not.toContain("「方位のズレ」には影響しない");
  });

  it("中心線の向きも動いている可能性があり、§10.2 の方位判定にも影響しうると書く", () => {
    expect(source).toContain("AC-P2-02 の許容（7°）を超えている");
    expect(source).toContain("ずれが滑走路中心線に沿った方向だけとは言えず");
    expect(source).toContain("中心線の向きも動いている可能性があり、docs/spec.md §10.2 の方位判定にも影響しうる");
  });

  it("距離のずれの大きさは、許容を超えていても同じように書く", () => {
    expect(source).toContain("端の座標のずれは最大 0.22km");
    expect(source).toContain("距離を使う判定・採点すべてがこの分だけ動く");
  });
});
