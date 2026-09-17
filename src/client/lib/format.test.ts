import { describe, expect, it } from "vitest";
import { VERTICAL_RATE_THRESHOLD_FPM } from "../../shared/estimate.ts";
import {
  airportShortLabel,
  DASH,
  DEFAULT_UNITS,
  finiteOrUndefined,
  formatAltitudeFt,
  formatAltitudeM,
  formatBearing,
  formatDistanceKm,
  formatElevationDeg,
  formatSecondsAgo,
  formatSpeedKt,
  formatTrend,
  formatVerticalRateFpm,
  isFiniteNumber,
  nonEmpty,
  normalizeZero,
  verticalTrend,
} from "./format.ts";

describe("DASH", () => {
  it("値の無い項目は「—」", () => {
    expect(DASH).toBe("—");
  });
});

describe("formatAltitudeFt / formatAltitudeM（ft → m、10m 単位に丸めて桁区切り）", () => {
  it.each([
    [6600, "2,010m"], // 6600 × 0.3048 = 2011.68 → 2010
    [21654, "6,600m"], // 21654 × 0.3048 = 6600.14 → 6600（S-02 の「6,600m」）
    [3000, "910m"], // 914.4 → 910
    [0, "0m"],
  ])("%s ft → %s", (feet, expected) => {
    expect(formatAltitudeFt(feet)).toBe(expected);
  });

  it.each([
    [914.4, "910m"],
    [12345, "12,350m"], // 1234.5 → 1235 → 12350
    [1004.9, "1,000m"],
    [-304.8, "-300m"],
  ])("%s m → %s", (meters, expected) => {
    expect(formatAltitudeM(meters)).toBe(expected);
  });

  it.each([null, undefined, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])("%s → 「—」", (value) => {
    expect(formatAltitudeFt(value)).toBe("—");
    expect(formatAltitudeM(value)).toBe("—");
  });

  it("-0 に丸まる負の小さな値は「0m」（-4m、-10ft = -3.048m）", () => {
    expect(formatAltitudeM(-4)).toBe("0m");
    expect(formatAltitudeFt(-10)).toBe("0m");
  });
});

describe("formatSpeedKt（kt → km/h の整数）", () => {
  it.each([
    [250, "463km/h"], // 250 × 1.852 = 463
    [480, "889km/h"], // 888.96 → 889
    [0, "0km/h"],
  ])("%s kt → %s", (knots, expected) => {
    expect(formatSpeedKt(knots)).toBe(expected);
  });

  it.each([null, undefined, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])("%s → 「—」", (value) => {
    expect(formatSpeedKt(value)).toBe("—");
  });

  it("-0 に丸まる負の小さな値は「0km/h」（-0.2kt = -0.37km/h）", () => {
    expect(formatSpeedKt(-0.2)).toBe("0km/h");
  });
});

describe("表示の単位（F-09・仕様 Q6・AC-P2-72）", () => {
  it("既定は m と km/h", () => {
    expect(DEFAULT_UNITS).toEqual({ altitude: "m", speed: "kmh" });
  });

  // W9 MINOR-5: m → ft の換算口（`formatAltitudeM` の単位指定）は無くしたので、
  // ft 表示の入口は受信値（ft）を受ける `formatAltitudeFt` だけ。`formatAltitudeM` は m 専用
  describe("formatAltitudeFt: 単位 ft（10 単位に丸めて桁区切り。m と同じ流儀）", () => {
    it.each([
      [6600, "6,600ft"],
      [21654, "21,650ft"], // 10ft 単位に丸める
      [999, "1,000ft"],
      [0, "0ft"],
      [-10, "-10ft"],
    ])("%s ft → %s", (feet, expected) => {
      expect(formatAltitudeFt(feet, "ft")).toBe(expected);
    });

    it.each([
      [36089, "36,090ft"], // 巡航 11,000m ≒ 36,089ft → 36,090
      [875, "880ft"], // 25ft 刻みの受信値も m へ往復させずそのまま丸める
    ])("受信値 %s ft はそのまま丸めて %s", (feet, expected) => {
      expect(formatAltitudeFt(feet, "ft")).toBe(expected);
    });

    it("単位を省くと既定の m（明示した m と同じ）", () => {
      expect(formatAltitudeM(2011.68)).toBe("2,010m");
      expect(formatAltitudeFt(6600)).toBe(formatAltitudeFt(6600, "m"));
      expect(formatAltitudeFt(6600)).toBe("2,010m");
    });

    it.each([null, undefined, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])("値が無ければ単位に関わらず「—」（%s）", (value) => {
      expect(formatAltitudeFt(value, "ft")).toBe("—");
      expect(formatAltitudeFt(value)).toBe("—");
      expect(formatAltitudeM(value)).toBe("—");
    });

    it("-0 に丸まる負の小さな値は「0ft」（-4ft）", () => {
      expect(formatAltitudeFt(-4, "ft")).toBe("0ft");
    });
  });

  describe("formatSpeedKt: 単位 kt（km/h と同じく整数に丸める）", () => {
    it.each([
      [250, "250kt"],
      [480.4, "480kt"], // 480.4 → 480
      [0, "0kt"],
    ])("%s kt → %s", (knots, expected) => {
      expect(formatSpeedKt(knots, "kt")).toBe(expected);
    });

    it("単位を省くと既定の km/h（明示した kmh と同じ）", () => {
      expect(formatSpeedKt(250)).toBe(formatSpeedKt(250, "kmh"));
      expect(formatSpeedKt(250)).toBe("463km/h");
    });

    it.each([null, undefined, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])("値が無ければ単位に関わらず「—」（%s）", (value) => {
      expect(formatSpeedKt(value, "kt")).toBe("—");
    });

    it("-0 に丸まる負の小さな値は「0kt」（-0.2kt）", () => {
      expect(formatSpeedKt(-0.2, "kt")).toBe("0kt");
    });
  });

  it("昇降率は単位の切り替えの対象外（仕様 Q15「昇降率の単位は fpm」。単位の引数を取らない）", () => {
    expect(formatVerticalRateFpm(1000)).toBe("+1000fpm");
  });

  it("距離は単位の切り替えの対象外（km のまま。F-09 は高度と速度だけを挙げている）", () => {
    expect(formatDistanceKm(12.4)).toBe("12km");
  });
});

describe("formatDistanceKm（10km 未満は小数 1 桁、以上は整数）", () => {
  it.each([
    [9.94, "9.9km"],
    [9.96, "10km"], // 小数 1 桁に丸めると 10.0 → 整数表示
    [10, "10km"],
    [12.4, "12km"],
    [37.79, "38km"],
    [0.04, "0.0km"],
  ])("%s km → %s", (km, expected) => {
    expect(formatDistanceKm(km)).toBe(expected);
  });

  it.each([null, undefined, Number.NaN])("%s → 「—」", (value) => {
    expect(formatDistanceKm(value)).toBe("—");
  });

  it("-0 に丸まる負の小さな値は「0.0km」（-0.04km）", () => {
    expect(formatDistanceKm(-0.04)).toBe("0.0km");
  });
});

describe("verticalTrend（±200fpm が境界、±200 ちょうどは水平）", () => {
  it.each([
    [200, "level"],
    [201, "climb"],
    [-200, "level"],
    [-201, "descend"],
    [0, "level"],
    [2500, "climb"],
    [-704, "descend"],
  ] as const)("%s fpm → %s", (fpm, expected) => {
    expect(verticalTrend(fpm)).toBe(expected);
  });

  it.each([undefined, null, Number.NaN])("%s → undefined（記号を出さない）", (value) => {
    expect(verticalTrend(value)).toBeUndefined();
  });
});

describe("formatTrend（記号と文字の両方）", () => {
  it.each([
    ["climb", "▲ 上昇"],
    ["descend", "▼ 下降"],
    ["level", "― 水平"],
  ] as const)("%s → %s", (trend, expected) => {
    expect(formatTrend(trend)).toBe(expected);
  });

  it("区分が無ければ undefined", () => {
    expect(formatTrend(undefined)).toBeUndefined();
  });

  it("昇降率から区分を経て文字にする（201 → 上昇、-201 → 下降、200 → 水平）", () => {
    expect(formatTrend(verticalTrend(201))).toBe("▲ 上昇");
    expect(formatTrend(verticalTrend(-201))).toBe("▼ 下降");
    expect(formatTrend(verticalTrend(200))).toBe("― 水平");
  });
});

// 書式は根拠（evidence）の行（src/server/estimate/estimate.ts の verticalRateEvidence。
// 「上昇中 +1500fpm」「降下中 -704fpm」「水平飛行 0fpm」）に合わせる（仕様 Q15・AC-P3-20/21）
describe("formatVerticalRateFpm（fpm のまま整数、正は + 付き）", () => {
  it.each([
    [1500, "+1500fpm"], // evidence の「上昇中 +1500fpm」と同じ数字・同じ単位
    [-704, "-704fpm"], // evidence の「降下中 -704fpm」と同じ
    [0, "0fpm"], // evidence の「水平飛行 0fpm」と同じ
    [-1000, "-1000fpm"],
    // (0, 200] は evidence と符号の扱いが**意図的に**違う（サーバーは「水平飛行 150fpm」と符号を出さない）。
    // 詳細の「昇降率」の行には向きを表す語が無く、+150 と -150 の見分けが符号だけに掛かっているため、
    // クライアントは正なら必ず "+" を付ける。evidence に合わせて "+" を落とさないこと
    [150, "+150fpm"],
    [VERTICAL_RATE_THRESHOLD_FPM, "+200fpm"], // しきい値ちょうど（evidence は「水平飛行 200fpm」）
    [-150, "-150fpm"],
    [1000.4, "+1000fpm"], // 丸めは evidence と同じ Math.round
    [-704.5, "-704fpm"], // Math.round は .5 を +∞ 方向へ。evidence も同じ関数なので数字がずれない
  ])("%s fpm → %s", (fpm, expected) => {
    expect(formatVerticalRateFpm(fpm)).toBe(expected);
  });

  it("桁区切りはしない（evidence の「+1500fpm」に揃える。高度の「1,500ft」とは別の流儀）", () => {
    expect(formatVerticalRateFpm(2400)).toBe("+2400fpm");
  });

  it.each([null, undefined, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])("%s → 「—」", (value) => {
    expect(formatVerticalRateFpm(value)).toBe("—");
  });

  it("-0 に丸まる負の小さな値は「0fpm」（-0.4fpm）", () => {
    expect(formatVerticalRateFpm(-0.4)).toBe("0fpm");
  });
});

describe("formatBearing（16 方位の日本語）", () => {
  it.each([
    [0, "北"],
    [200.4, "南南西"],
    [90, "東"],
    [348.75, "北"],
  ])("%s° → %s", (deg, expected) => {
    expect(formatBearing(deg)).toBe(expected);
  });

  it("非有限（NaN・Infinity）と値無し（undefined・null）で「—」（どれも bearingToJa16 が undefined を返す）", () => {
    expect(formatBearing(Number.NaN)).toBe("—");
    expect(formatBearing(Number.POSITIVE_INFINITY)).toBe("—");
    expect(formatBearing(undefined)).toBe("—");
    expect(formatBearing(null)).toBe("—");
  });
});

describe("formatElevationDeg（10° 未満は 0.1° 単位で負の方向に切り捨てて小数 1 桁、10° 以上は整数に丸める）", () => {
  it.each([
    [9.99, "9.9°"],
    [10, "10°"],
    [10.4, "10°"],
    [0, "0.0°"],
    [-0.01, "-0.1°"],
    [-0.4, "-0.4°"],
    [1.19, "1.1°"],
    [45.6, "46°"],
    [9.5, "9.5°"],
    [45, "45°"],
    [-1.4, "-1.4°"],
    [-2.6, "-2.6°"],
  ])("%s → %s", (deg, expected) => {
    expect(formatElevationDeg(deg)).toBe(expected);
  });

  it("-0 は「0.0°」（「-0.0°」にしない）", () => {
    expect(formatElevationDeg(-0)).toBe("0.0°");
  });

  it.each([null, undefined, Number.NaN])("%s → 「—」", (value) => {
    expect(formatElevationDeg(value)).toBe("—");
  });
});

describe("formatSecondsAgo（切り捨て、負は 0）", () => {
  it.each([
    [3.9, "3 秒前"],
    [0, "0 秒前"],
    [59.999, "59 秒前"],
    [-2, "0 秒前"],
    [-0.5, "0 秒前"],
  ])("%s 秒 → %s", (seconds, expected) => {
    expect(formatSecondsAgo(seconds)).toBe(expected);
  });

  it("値が無ければ「—」", () => {
    expect(formatSecondsAgo(undefined)).toBe("—");
    expect(formatSecondsAgo(Number.NaN)).toBe("—");
  });

  it("-0 秒は「0 秒前」", () => {
    expect(formatSecondsAgo(-0)).toBe("0 秒前");
  });
});

describe("normalizeZero（-0 を 0 に）", () => {
  it("-0 → +0、+0 → +0", () => {
    expect(Object.is(normalizeZero(-0), 0)).toBe(true);
    expect(Object.is(normalizeZero(0), 0)).toBe(true);
  });

  it("0 以外はそのまま", () => {
    expect(normalizeZero(-3.5)).toBe(-3.5);
    expect(normalizeZero(12)).toBe(12);
  });
});

describe("isFiniteNumber / finiteOrUndefined / nonEmpty", () => {
  it.each([
    [0, true],
    [-1.5, true],
    [Number.NaN, false],
    [Number.POSITIVE_INFINITY, false],
    [Number.NEGATIVE_INFINITY, false],
    [null, false],
    [undefined, false],
  ])("isFiniteNumber(%s) → %s", (value, expected) => {
    expect(isFiniteNumber(value)).toBe(expected);
    expect(finiteOrUndefined(value)).toBe(expected ? value : undefined);
  });

  it.each([
    [" JAL123 ", "JAL123"],
    ["ANA5", "ANA5"],
    ["   ", undefined],
    ["", undefined],
    [undefined, undefined],
  ])("nonEmpty(%j) → %s", (text, expected) => {
    expect(nonEmpty(text)).toBe(expected);
  });
});

describe("airportShortLabel（IATA（無ければ ICAO）＋空白＋都市名）", () => {
  it("IATA と都市名 → 「HND Tokyo」", () => {
    expect(airportShortLabel({ icao: "RJTT", iata: "HND", municipality: "Tokyo" })).toBe("HND Tokyo");
  });

  it("IATA が無ければ ICAO → 「RJTT Tokyo」", () => {
    expect(airportShortLabel({ icao: "RJTT", municipality: "Tokyo" })).toBe("RJTT Tokyo");
  });

  it("都市名が無ければコードのみ → 「HND」", () => {
    expect(airportShortLabel({ icao: "RJTT", iata: "HND" })).toBe("HND");
  });

  it("空文字の IATA・都市名は無いものとして扱う", () => {
    expect(airportShortLabel({ icao: "RJTT", iata: "", municipality: "  " })).toBe("RJTT");
  });
});
