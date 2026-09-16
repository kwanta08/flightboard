// OurAirports の runways.csv（パブリックドメイン、https://ourairports.com/data/）から
// 滑走路端を取り込む純粋関数と、src/server/data/runways.ts のソースを組み立てる関数。
// ファイルの読み書き・ネットワークはここでは行わない（配線は src/tools/importRunways.ts）。
//
// 列名は spike/aip_import.py の実績に合わせる（airport_ident / {le,he}_ident /
// {le,he}_latitude_deg / {le,he}_longitude_deg / {le,he}_heading_degT）＋ length_ft。
// closed 列と length_ft 列は有れば使い、無くても動く。
import { FT_TO_M, bearingDeg, haversineKm } from "../../shared/geo.ts";
import { MAGNETIC_VARIATION_DEG } from "./airports.ts";

export type RunwayEnd = {
  icao: string;
  /** 滑走路端の識別子（例: "22"・"16L"）。数字は磁方位を 10° に丸めたもの（ICAO Annex 14） */
  ident: string;
  lat: number;
  lon: number;
  /** 対向端の識別子。真方位はデータに持たず、自端 → 対向端の座標から計算する */
  oppositeIdent: string;
  /** 公示滑走路長（ft）。CSV に列が無い・空なら undefined */
  lengthFt?: number;
};

/**
 * 対向端どうしの距離が公示滑走路長の ±10%（LENGTH_TOLERANCE）を外れた滑走路（AC-P2-03）。
 * 取り込みの時点で検出し、生成物のヘッダと KNOWN_LENGTH_MISMATCHES に記録する。
 * **例外をテスト側の定数に書かない**ための型で、テストはここに申告された集合と実測の集合を突き合わせる。
 */
export type LengthMismatch = {
  icao: string;
  /** 滑走路を代表する端の識別子（対向する 2 端のうち識別子の昇順で先の方） */
  ident: string;
  /** その対向端の識別子 */
  oppositeIdent: string;
  /** 対向端どうしの距離（km） */
  endsApartKm: number;
  /** 公示滑走路長（km。CSV の length_ft から換算） */
  publishedKm: number;
  /** 公示滑走路長に対するずれの比（-0.133 なら端の間が 13.3% 短い） */
  deviation: number;
  /**
   * 2 端のうち「指示子（磁方位）と座標から計算した真方位」の食い違いが大きい方の絶対値（度）。
   * これが AC-P2-02 の許容内に収まっていれば、ずれは滑走路中心線に沿った方向のもので、
   * 中心線の向き自体は動いていないと言える。
   */
  identDeviationDeg: number;
};

export type ImportedRunways = {
  /** 対象 ICAO の滑走路端。ICAO は指定した順、同じ空港では識別子の昇順 */
  ends: RunwayEnd[];
  /** 取り込みで見つけた食い違い。呼び出し側がログに出す（取り込み自体は止めない） */
  warnings: string[];
  /** 公示滑走路長と座標が ±10% を超えて食い違う滑走路（AC-P2-03 の既知の不一致） */
  lengthMismatches: LengthMismatch[];
};

/** 座標から計算した真方位と CSV の `_heading_degT` の差がこれを超えたら警告する（度） */
const HEADING_TOLERANCE_DEG = 1;

/** 対向端どうしの距離と公示滑走路長のずれがこれを超えたら「既知の不一致」に記録する（比。AC-P2-03） */
export const LENGTH_TOLERANCE = 0.1;

/**
 * 指示子（磁方位）と座標から計算した真方位の食い違いの許容（度。AC-P2-02）。
 * 既知の不一致の説明を「中心線に沿ったずれ」と書いてよいかの分かれ目にだけ使う。
 */
const IDENT_TOLERANCE_DEG = 7;

/** docs/spec.md §10.2 の採点（採点 = 方位のズレ + 距離km × 0.3）で距離に掛かる係数（点/km） */
const SCORE_PER_KM = 0.3;

/** docs/spec.md §10.2 の許容ズレ（20° − 距離km × 0.4）で距離に掛かる係数（度/km） */
const TOLERANCE_DEG_PER_KM = 0.4;

/** `closed` 列が閉鎖を表す値（列が無ければ「閉鎖でない」とみなす） */
const CLOSED_VALUES = new Set(["1", "true", "yes"]);

const REQUIRED_COLUMNS = [
  "airport_ident",
  "le_ident",
  "le_latitude_deg",
  "le_longitude_deg",
  "he_ident",
  "he_latitude_deg",
  "he_longitude_deg",
] as const;

/** CSV（RFC4180）を行 × 列に分解する。引用符付きフィールド（"" は 1 つの "）と CRLF・空行に対応する */
function parseCsvRows(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let hasField = false; // 空行（区切りも引用符も無い行）を捨てるための印
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (quoted) {
      if (char !== '"') {
        field += char;
      } else if (text[i + 1] === '"') {
        field += '"';
        i += 1;
      } else {
        quoted = false;
      }
      continue;
    }
    if (char === '"') {
      quoted = true;
      hasField = true;
    } else if (char === ",") {
      row.push(field);
      field = "";
      hasField = true;
    } else if (char === "\n" || char === "\r") {
      if (char === "\r" && text[i + 1] === "\n") {
        i += 1;
      }
      if (hasField || field !== "") {
        row.push(field);
        rows.push(row);
      }
      row = [];
      field = "";
      hasField = false;
    } else {
      field += char;
      hasField = true;
    }
  }
  if (hasField || field !== "") {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

/** 空でない数値なら値、空・非数なら undefined */
function parseNumber(value: string): number | undefined {
  if (value === "") {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/** 生成物に書く数値を桁で丸める（浮動小数の尾を持ち込まない） */
function round(value: number, digits: number): number {
  return Number(value.toFixed(digits));
}

/** 角度の差を [-180, 180) に畳む */
function angleDiffDeg(a: number, b: number): number {
  return ((a - b + 540) % 360) - 180;
}

/**
 * runways.csv の文字列から、対象 ICAO の滑走路端を取り出す（ネットワークにもファイルにも触らない）。
 *
 * - ヘッダ行から列を引く。必要な列（REQUIRED_COLUMNS）が無ければ TypeError。
 * - `closed` が立っている滑走路と、対象外の ICAO の行は捨てる。
 * - 緯度・経度が空の端は取り込まない。真方位は対向端の座標から計算するので、
 *   片側の座標が欠けている滑走路は**両端とも**取り込まない（警告を出す）。
 * - `{le,he}_heading_degT` があり、座標から計算した真方位と 1° を超えて食い違う行は、
 *   警告を出したうえで**座標側を採る**（真方位は常に座標から計算するため、拒否はしない）。
 * - 同じ空港に同じ識別子の端を作る行（同一行の両端が同じ識別子の場合を含む）は、
 *   **先に現れた行を採り**、後の行を警告して捨てる。
 * - `length_ft` がある滑走路で、対向端どうしの距離が公示滑走路長の ±10% を外れたものは
 *   `lengthMismatches` に記録する（AC-P2-03 の「既知の不一致」。取り込みは止めない）。
 */
export function importRunwayEnds(csv: string, icaos: readonly string[]): ImportedRunways {
  const rows = parseCsvRows(csv);
  const header = rows[0];
  if (!header) {
    throw new TypeError("runways.csv が空です");
  }
  const columns = new Map(header.map((name, index) => [name.trim(), index]));
  const missing = REQUIRED_COLUMNS.filter((name) => !columns.has(name));
  if (missing.length > 0) {
    throw new TypeError(`runways.csv に必要な列がありません: ${missing.join(", ")}`);
  }

  const targets = new Set(icaos);
  const cell = (row: readonly string[], name: string): string => {
    const index = columns.get(name);
    return index === undefined ? "" : (row[index] ?? "").trim();
  };

  const side = (row: readonly string[], prefix: "le" | "he") => {
    const ident = cell(row, `${prefix}_ident`);
    const lat = parseNumber(cell(row, `${prefix}_latitude_deg`));
    const lon = parseNumber(cell(row, `${prefix}_longitude_deg`));
    const headingDegT = parseNumber(cell(row, `${prefix}_heading_degT`));
    const point = ident === "" || lat === undefined || lon === undefined ? undefined : { lat, lon };
    return { ident, point, headingDegT };
  };

  const ends: RunwayEnd[] = [];
  const warnings: string[] = [];
  const lengthMismatches: LengthMismatch[] = [];
  const seenEnds = new Set<string>();
  for (const row of rows.slice(1)) {
    const icao = cell(row, "airport_ident");
    if (!targets.has(icao) || CLOSED_VALUES.has(cell(row, "closed").toLowerCase())) {
      continue;
    }
    const lengthFt = parseNumber(cell(row, "length_ft"));
    const le = side(row, "le");
    const he = side(row, "he");
    if (le.point === undefined || he.point === undefined) {
      warnings.push(
        `${icao} ${le.ident || "?"}/${he.ident || "?"}: 座標か識別子が空の端があるため、この滑走路を取り込まなかった`,
      );
      continue;
    }

    // 同じ空港・同じ識別子の端は 1 つだけにする（先に現れた行を採る）。片端だけ捨てると
    // 対向端の相互参照が壊れるので、重複した行は両端まとめて捨てる
    const duplicated = [le.ident, he.ident].filter(
      (ident, index, both) => seenEnds.has(`${icao} ${ident}`) || both.indexOf(ident) !== index,
    );
    if (duplicated.length > 0) {
      warnings.push(
        `${icao} ${le.ident}/${he.ident}: 識別子 ${duplicated.join("・")} の端が重複しているため、` +
          `この行を取り込まなかった（同じ空港・同じ識別子は先に現れた行を採る）`,
      );
      continue;
    }
    seenEnds.add(`${icao} ${le.ident}`);
    seenEnds.add(`${icao} ${he.ident}`);

    // 自端と対向端の組を 2 つ作る（真方位は自端 → 対向端の座標から計算する）
    const pairs = [
      { ident: le.ident, point: le.point, headingDegT: le.headingDegT, opposite: he.ident, oppositePoint: he.point },
      { ident: he.ident, point: he.point, headingDegT: he.headingDegT, opposite: le.ident, oppositePoint: le.point },
    ];
    for (const self of pairs) {
      const trueBearing = bearingDeg(self.point, self.oppositePoint);
      if (self.headingDegT !== undefined) {
        const diff = angleDiffDeg(self.headingDegT, trueBearing);
        if (Math.abs(diff) > HEADING_TOLERANCE_DEG) {
          warnings.push(
            `${icao} ${self.ident}: CSV の真方位 ${self.headingDegT.toFixed(1)}° と座標から計算した真方位 ` +
              `${trueBearing.toFixed(1)}° が ${Math.abs(diff).toFixed(1)}° 食い違う（座標側を採った）`,
          );
        }
      }
      ends.push({
        icao,
        ident: self.ident,
        lat: self.point.lat,
        lon: self.point.lon,
        oppositeIdent: self.opposite,
        ...(lengthFt === undefined ? {} : { lengthFt }),
      });
    }

    // AC-P2-03: 端の間の距離と公示滑走路長のずれ。±10% を外れたら既知の不一致として記録する
    if (lengthFt !== undefined) {
      const endsApartKm = haversineKm(le.point, he.point);
      const publishedKm = (lengthFt * FT_TO_M) / 1000;
      const deviation = endsApartKm / publishedKm - 1;
      if (publishedKm > 0 && Math.abs(deviation) > LENGTH_TOLERANCE) {
        const [first, second] = pairs[0]!.ident.localeCompare(pairs[1]!.ident, "en") <= 0
          ? [pairs[0]!, pairs[1]!]
          : [pairs[1]!, pairs[0]!];
        // 指示子（磁方位）と座標から計算した真方位の食い違い。中心線の向きが動いていないかを見る
        const identDeviationDeg = Math.max(
          ...[first, second].map((self) =>
            Math.abs(
              angleDiffDeg(
                bearingDeg(self.point, self.oppositePoint) + MAGNETIC_VARIATION_DEG,
                Number.parseInt(self.ident, 10) * 10,
              ),
            ),
          ),
        );
        lengthMismatches.push({
          icao,
          ident: first.ident,
          oppositeIdent: second.ident,
          endsApartKm: round(endsApartKm, 3),
          publishedKm: round(publishedKm, 3),
          deviation: round(deviation, 4),
          identDeviationDeg: round(identDeviationDeg, 1),
        });
      }
    }
  }

  const order = new Map(icaos.map((icao, index) => [icao, index]));
  ends.sort(
    (a, b) => (order.get(a.icao) ?? 0) - (order.get(b.icao) ?? 0) || a.ident.localeCompare(b.ident, "en"),
  );
  return { ends, warnings, lengthMismatches };
}

export type RenderRunwaysOptions = {
  /** 取り込み元の CSV（ファイル名。機械ごとに変わる絶対パスは書かない） */
  sourceName: string;
  /** 生成日（YYYY-MM-DD） */
  generatedAt: string;
  /** 取り込み時の警告（AC-P2-05）。ヘッダに残す。省略時は「なし」と書く */
  warnings?: readonly string[];
  /** AC-P2-03 の既知の不一致。ヘッダと KNOWN_LENGTH_MISMATCHES の両方に書く */
  lengthMismatches?: readonly LengthMismatch[];
};

function renderEnd(end: RunwayEnd): string {
  const length = end.lengthFt === undefined ? "" : `, lengthFt: ${end.lengthFt}`;
  return `  { icao: ${JSON.stringify(end.icao)}, ident: ${JSON.stringify(end.ident)}, lat: ${end.lat}, lon: ${end.lon}, oppositeIdent: ${JSON.stringify(end.oppositeIdent)}${length} },`;
}

function renderMismatch(mismatch: LengthMismatch): string {
  return (
    `  { icao: ${JSON.stringify(mismatch.icao)}, ident: ${JSON.stringify(mismatch.ident)}, ` +
    `oppositeIdent: ${JSON.stringify(mismatch.oppositeIdent)}, endsApartKm: ${mismatch.endsApartKm}, ` +
    `publishedKm: ${mismatch.publishedKm}, deviation: ${mismatch.deviation}, ` +
    `identDeviationDeg: ${mismatch.identDeviationDeg} },`
  );
}

/**
 * 既知の不一致（AC-P2-03）のヘッダ。1 件 1 行で `// 既知の不一致: <ICAO> <ident>/<対向端> — ...` の形にし、
 * テストが機械的に読み戻して集合を比べられるようにする。
 */
function renderMismatchHeader(mismatches: readonly LengthMismatch[]): string {
  const intro = [
    "// AC-P2-03（対向端どうしの距離が公示滑走路長の ±10% に収まる）を外れた滑走路。",
    "// 下の KNOWN_LENGTH_MISMATCHES と同じ内容で、src/server/data/runways.test.ts が",
    "// 「ここに申告された集合」と「実際に ±10% を外れた滑走路の集合」の完全一致を検査する",
    "// （例外をテスト側の定数に書かないため。黙らせるには取り込み直してここに載せるしかない）。",
  ];
  if (mismatches.length === 0) {
    return [...intro, "// 既知の不一致: なし"].join("\n");
  }
  const maxIdentDeviationDeg = Math.max(...mismatches.map((mismatch) => mismatch.identDeviationDeg));
  const maxShiftKm = Math.max(
    ...mismatches.map((mismatch) => Math.abs(mismatch.publishedKm - mismatch.endsApartKm)),
  );
  // 中心線の向きについて言えることは、指示子との食い違いが AC-P2-02 の許容に収まるかで変わる。
  // 値を見ずに「許容に収まっている」と書くと、収まらない不一致が出たときに嘘を書き出すことになる
  const centerline =
    maxIdentDeviationDeg <= IDENT_TOLERANCE_DEG
      ? [
          `// - 指示子（磁方位）と座標から計算した真方位の食い違いは最大 ${maxIdentDeviationDeg.toFixed(1)}° で、`,
          `//   AC-P2-02 の許容（${IDENT_TOLERANCE_DEG}°）に収まっている。つまりこのずれは**滑走路中心線に沿った方向のずれ**であり、`,
          "//   中心線の向きそのものは動いていない（片端または両端が中心線に沿ってずれた形。どちらかは不明）。",
          "// - したがって docs/spec.md §10.2 の主要な判別材料である「方位のズレ」には影響しない。",
        ]
      : [
          `// - 指示子（磁方位）と座標から計算した真方位の食い違いは最大 ${maxIdentDeviationDeg.toFixed(1)}° で、`,
          `//   AC-P2-02 の許容（${IDENT_TOLERANCE_DEG}°）を超えている。ずれが滑走路中心線に沿った方向だけとは言えず、`,
          "//   中心線の向きも動いている可能性があり、docs/spec.md §10.2 の方位判定にも影響しうる。",
        ];
  return [
    ...intro,
    ...mismatches.map(
      (mismatch) =>
        `// 既知の不一致: ${mismatch.icao} ${mismatch.ident}/${mismatch.oppositeIdent} — ` +
        `端間 ${mismatch.endsApartKm.toFixed(3)}km / 公示 ${mismatch.publishedKm.toFixed(3)}km` +
        `（${(mismatch.deviation * 100).toFixed(1)}%、差 ${Math.abs(mismatch.publishedKm - mismatch.endsApartKm).toFixed(3)}km）`,
    ),
    "//",
    "// この不一致について分かっていること:",
    ...centerline,
    `// - 端の座標のずれは最大 ${maxShiftKm.toFixed(2)}km。§10.2 は距離を evidence の「滑走路まで ◯km」の表示だけでなく、`,
    `//   採点（距離km × ${SCORE_PER_KM}）・許容ズレ（20° − 距離km × ${TOLERANCE_DEG_PER_KM}）・進入/出発の距離条件（35km / 25km）にも`,
    `//   使うので、距離を使う判定・採点すべてがこの分だけ動く（採点 ${(maxShiftKm * SCORE_PER_KM).toFixed(1)} 点・` +
      `許容ズレ ${(maxShiftKm * TOLERANCE_DEG_PER_KM).toFixed(2)}° 相当）。`,
    "// - **どちらの端が旧位置かは判別できていない**（OurAirports の座標だけでは決められないので断定しない）。",
    "// - AIP AD 2.12 の公示座標を持っていないので、座標側の補正はしていない。",
  ].join("\n");
}

/** 取り込み時の警告（AC-P2-05）。実際に出た警告だけを書く（未実証の一般論を書かない） */
function renderWarningsHeader(warnings: readonly string[]): string {
  if (warnings.length === 0) {
    return "// 取り込み時の警告: なし";
  }
  return [
    "// 取り込み時の警告（取り込みは止めていない。真方位は常に座標から計算する）:",
    ...warnings.map((warning) => `// 警告: ${warning}`),
  ].join("\n");
}

/** src/server/data/runways.ts のソースを組み立てる（CLI がこの文字列をそのまま書き出す） */
export function renderRunwaysModule(ends: readonly RunwayEnd[], options: RenderRunwaysOptions): string {
  const mismatches = options.lengthMismatches ?? [];
  const list = (lines: readonly string[]): string => (lines.length === 0 ? "[]" : `[\n${lines.join("\n")}\n]`);
  return `// 滑走路端のスナップショット（docs/spec.md §10.2 の滑走路推定が使う）。
//
// **このファイルは自動生成です。手で編集しないでください。**
// 出所: OurAirports の runways.csv（パブリックドメイン、https://ourairports.com/data/）
// 取り込み元: ${options.sourceName}
// 生成日: ${options.generatedAt}
// 再生成: npm run import-runways -- <runways.csv のパス>
//
// 座標は OurAirports の値をそのまま持つ。AIP など一次情報との突き合わせはしていないので、
// 数十 m の誤差は検出できていない（src/server/data/runways.test.ts が見るのは、指示子との
// 方位の食い違いと公示滑走路長との差だけ）。
// 真方位はデータに持たない。自端 → 対向端の座標から bearingDeg() で計算する。
// CSV の {le,he}_heading_degT は取り込み時の突き合わせにだけ使い（差が 1° を超えたら下の警告に出す）、
// 値そのものはここへ持ち込まない。
//
${renderWarningsHeader(options.warnings ?? [])}
//
${renderMismatchHeader(mismatches)}
//
// 磁気偏角（MAGNETIC_VARIATION_DEG）は人が決める設定値なので、生成物ではなく
// 手で保守する src/server/data/airports.ts にある。
import type { LengthMismatch, RunwayEnd } from "./importRunways.ts";

/** 対象空港の滑走路端。ident は磁方位ベースの指示子（例: "16L"） */
export const RUNWAY_ENDS: readonly RunwayEnd[] = ${list(ends.map(renderEnd))};

/**
 * AC-P2-03 の既知の不一致（上のヘッダと同じ内容を、機械的に読める形で持つ）。
 * 取り込み（importRunwayEnds）が検出したものだけが入る。手で足さない・消さない。
 */
export const KNOWN_LENGTH_MISMATCHES: readonly LengthMismatch[] = ${list(mismatches.map(renderMismatch))};

const ENDS_BY_ICAO = new Map<string, RunwayEnd[]>();
for (const end of RUNWAY_ENDS) {
  const ends = ENDS_BY_ICAO.get(end.icao);
  if (ends) {
    ends.push(end);
  } else {
    ENDS_BY_ICAO.set(end.icao, [end]);
  }
}

const NO_ENDS: readonly RunwayEnd[] = [];

/** その空港の滑走路端（RUNWAY_ENDS の並び順）。対象外の ICAO では空配列 */
export function runwayEndsFor(icao: string): readonly RunwayEnd[] {
  return ENDS_BY_ICAO.get(icao) ?? NO_ENDS;
}
`;
}
