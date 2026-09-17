// 推定の組み立て（docs/spec.md §10.2、plan の「estimate の生成規則と confidence 表」）。
// フェーズ判定（phase.ts）と滑走路の採点（runway.ts）を束ね、Flight["estimate"] を作る純粋関数。
// 入力は単発の Flight と（省略可能な）その機体の航跡だけで、I/O・グローバル状態は使わない。
// 航跡は並行滑走路の出発で L/C/R を判別するときだけ使う（AC-P3-05）。
import { airportDisplayName } from "../../shared/airports.ts";
import { formatFpm } from "../../shared/estimate.ts";
import { type LatLon, haversineKm } from "../../shared/geo.ts";
import type { Flight } from "../../shared/types.ts";
import { TARGET_AIRPORTS, type TargetAirport } from "../data/airports.ts";
import type { RunwayEnd } from "../data/importRunways.ts";
import { RUNWAY_ENDS } from "../data/runways.ts";
import {
  type FlightPhase,
  type PhaseResult,
  VERTICAL_RATE_THRESHOLD_FPM,
  detectPhase,
  finiteOrUndefined,
} from "./phase.ts";
import { type RunwaySelection, selectRunway } from "./runway.ts";

type Estimate = NonNullable<Flight["estimate"]>;

/** 滑走路が決まった候補の confidence の素点（§10.2・plan の confidence 表） */
export const CONFIDENCE_RUNWAY_STRONG = 0.9;
export const CONFIDENCE_RUNWAY_MEDIUM = 0.6;
export const CONFIDENCE_RUNWAY_WEAK = 0.3;

/** 素点が CONFIDENCE_RUNWAY_STRONG になる条件（ズレ < 2° かつ 距離 < 25km） */
export const STRONG_HEADING_OFF_DEG = 2;
export const STRONG_DISTANCE_KM = 25;

/** 素点が CONFIDENCE_RUNWAY_MEDIUM になる条件（ズレ < 許容ズレ × この比） */
export const MEDIUM_TOLERANCE_RATIO = 0.5;

/** 滑走路が決まらない進入／出発（route の裏付けあり / 幾何のみ）と、通過の confidence */
export const CONFIDENCE_ROUTE_ONLY = 0.5;
export const CONFIDENCE_GEOMETRY_ONLY = 0.3;
export const CONFIDENCE_ENROUTE = 0.5;

/** route の裏付けと幾何判定が食い違ったときの減点と、その下限（AC-P2-14） */
export const DISAGREEMENT_PENALTY = 0.2;
export const MIN_CONFIDENCE = 0.1;

/** evidence に出すフェーズの呼び名 */
const PHASE_LABELS: Readonly<Record<FlightPhase, string>> = {
  arrival: "進入",
  departure: "出発",
  enroute: "通過",
  unknown: "不明",
};

/** route（adsbdb）が示す第一候補のフェーズと、その空港（AC-P2-14） */
type RouteBacking = { phase: "arrival" | "departure"; airport: TargetAirport };

/**
 * 単発の Flight から推定を組み立てる。生成規則（plan の表）:
 * - 進入／出発で滑走路が決まった → estimate あり（runway あり）
 * - 進入／出発で滑走路が決まらない → estimate あり（runway なし。route の裏付けがあれば 0.5、幾何のみ 0.3）
 *   幾何が裏を取れない（unknown・route と食い違う）ときも滑走路は決めない（AC-P2-16。食い違いなら 0.5 − 0.2 = 0.3）
 * - 通過 → estimate あり（airport・runway なし、0.5）
 * - 不明 かつ 滑走路なし → undefined（推定を付けない）
 *
 * `track`（その機体の航跡。**古い順**）は省略できる。渡すと並行滑走路の**出発**で L/C/R を判別できる（AC-P3-05）。
 * 渡さなければ Phase 2 と同じ入力で、出発の L/C/R は「決めない」（＝数字だけ）に落ちる。
 * 単独の組（羽田 04 / 22 / 05 / 23）は航跡の有無で結果が変わらない（AC-P3-08）。
 */
export function buildEstimate(
  flight: Flight,
  ends: readonly RunwayEnd[] = RUNWAY_ENDS,
  airports: readonly TargetAirport[] = TARGET_AIRPORTS,
  track?: readonly LatLon[],
): Flight["estimate"] | undefined {
  // ends はフェーズ判定にも渡す（基準点＝滑走路端。絞って渡したとき、フェーズの基準点と候補探索で見る端を揃える）
  const geometry = detectPhase(flight, airports, ends);
  const route = routeBacking(flight, geometry, airports);
  // 最終的な phase は route 由来にし、滑走路の候補探索もその phase の条件で行う（AC-P2-14 / 19）
  const phase = route?.phase ?? geometry.phase;

  // 候補探索は対象空港の滑走路端だけを見る（ends と airports で見る空港が食い違わないようにする）
  const targetEnds = ends.filter((end) => airports.some((airport) => airport.icao === end.icao));
  // AC-P2-16: 候補探索は「幾何判定の phase が最終的な phase と一致する」ときだけ行う
  // （spec §10.2「第一候補には adsbdb を使い、幾何判定で裏を取る」の「裏を取る」がこれ）。
  // 幾何が unknown のとき（高度・trackDeg・verticalRateFpm の欠損、AC-P2-10/11 の高度条件を満たさない機体）も、
  // route と食い違うときも一致しないので、滑走路は決めない。
  const searchPhase = (phase === "arrival" || phase === "departure") && geometry.phase === phase ? phase : undefined;
  const selection = searchPhase ? searchRunway(flight, searchPhase, targetEnds, track) : undefined;
  const runwayAirport = selection ? findAirport(airports, selection.end.icao) : undefined;
  // 滑走路が決まればその空港。決まらなければ route の裏付け → 接近／離脱と判定した空港の順
  const airport = phase === "enroute" ? undefined : (runwayAirport ?? route?.airport ?? geometry.airport);

  const disagreement = describeDisagreement(route, geometry, runwayAirport ?? geometry.airport);
  // 素点は**選ばれた端**の値から出す（未判別なら組内で採点最小の端。AC-P3-10。値は selection が持っている）
  const rawConfidence = baseConfidence(phase, selection, route);
  if (rawConfidence === undefined) {
    return undefined; // phase = "unknown" かつ滑走路なし
  }
  // AC-P3-07: 並行の組は進入・出発とも「1 点の横ずれ」で L/C/R を決めており誤判別帯が残るので、
  // 確度を「中」で頭打ちにする（決めた／決めなかったの別によらない。判定は runway.ts の capConfidence）。
  // **食い違い減点より前**に掛ける（後に掛けると減点後の 0.4 が 0.6 に上がってしまう）
  const capped = selection?.capConfidence ? Math.min(rawConfidence, CONFIDENCE_RUNWAY_MEDIUM) : rawConfidence;

  const estimate: Estimate = {
    phase,
    confidence: disagreement ? applyDisagreementPenalty(capped) : capped,
    evidence: buildEvidence({ flight, airport, selection, route, disagreement }),
  };
  if (airport) {
    estimate.airport = { icao: airport.icao, name: airportName(airport.icao) };
  }
  if (selection) {
    // L/C/R まで決まれば端の ident、決まらなければ指示子の数字だけ（"16"。AC-P3-06）
    estimate.runway = selection.runway;
  }
  return estimate;
}

/** 食い違いの減点（素点 − 0.2、下限 0.1）。小数の丸め誤差を残さないよう小数 2 桁に丸める */
export function applyDisagreementPenalty(confidence: number): number {
  return Math.max(MIN_CONFIDENCE, Math.round((confidence - DISAGREEMENT_PENALTY) * 100) / 100);
}

/**
 * confidence の素点。undefined なら推定を付けない（不明 かつ 滑走路なし）。
 * 値は**選ばれた端**のもの（未判別なら組内で採点最小の端。AC-P3-10）。上限（AC-P3-07）は呼び出し側で掛ける
 */
function baseConfidence(
  phase: FlightPhase,
  selection: RunwaySelection | undefined,
  route: RouteBacking | undefined,
): number | undefined {
  if (selection) {
    if (selection.headingOffDeg < STRONG_HEADING_OFF_DEG && selection.distanceKm < STRONG_DISTANCE_KM) {
      return CONFIDENCE_RUNWAY_STRONG;
    }
    if (selection.headingOffDeg < selection.toleranceDeg * MEDIUM_TOLERANCE_RATIO) {
      return CONFIDENCE_RUNWAY_MEDIUM;
    }
    return CONFIDENCE_RUNWAY_WEAK;
  }
  if (phase === "enroute") {
    return CONFIDENCE_ENROUTE;
  }
  if (phase === "arrival" || phase === "departure") {
    return route ? CONFIDENCE_ROUTE_ONLY : CONFIDENCE_GEOMETRY_ONLY;
  }
  return undefined;
}

/** route の出発地・到着地が対象空港なら、それを第一候補のフェーズにする（AC-P2-14） */
function routeBacking(
  flight: Flight,
  geometry: PhaseResult,
  airports: readonly TargetAirport[],
): RouteBacking | undefined {
  const route = flight.route;
  if (!route) {
    return undefined;
  }
  const backings: RouteBacking[] = [];
  const origin = findAirport(airports, route.origin?.icao);
  if (origin) {
    backings.push({ phase: "departure", airport: origin });
  }
  const destination = findAirport(airports, route.destination?.icao);
  if (destination) {
    backings.push({ phase: "arrival", airport: destination });
  }
  if (backings.length <= 1) {
    return backings[0];
  }
  // 対象空港どうしを結ぶ便（出発地も到着地も対象）では、幾何判定と一致する方を採り、
  // 幾何が決まっていなければ機体に近い方を採る（spec に定めが無いのでここで決めた）
  return (
    backings.find((backing) => backing.phase === geometry.phase) ??
    [...backings].sort(
      (a, b) => haversineKm(flight.position, a.airport) - haversineKm(flight.position, b.airport),
    )[0]
  );
}

/**
 * route の裏付けと幾何判定の食い違い（AC-P2-14）。食い違わなければ undefined。
 * 空港は evidence の他の行（「羽田まで 40.0km」）と同じ呼び名（shortName）で出す（W9 MINOR-3）
 */
function describeDisagreement(
  route: RouteBacking | undefined,
  geometry: PhaseResult,
  geometryAirport: TargetAirport | undefined,
): string | undefined {
  if (!route) {
    return undefined;
  }
  // 幾何が決めきれなかった（unknown）ときは食い違いに数えない
  const phaseDiffers = geometry.phase !== "unknown" && geometry.phase !== route.phase;
  const phaseText = phaseDiffers ? PHASE_LABELS[geometry.phase] : undefined;
  const airportText =
    geometryAirport && geometryAirport.icao !== route.airport.icao ? airportName(geometryAirport.icao) : undefined;
  if (phaseText === undefined && airportText === undefined) {
    return undefined;
  }
  return `幾何判定は ${[airportText, phaseText].filter((part) => part !== undefined).join(" ")}`;
}

/**
 * 滑走路の候補探索。進行方向・昇降率が欠けていれば探索しない（AC-P2-15）。
 * AC-P2-16 により、幾何判定が同じ phase を返したとき（＝ detectPhase が両方を有限だと確かめたとき）
 * しか呼ばれないので、この番人は実際には通り抜けるだけだが、関数単体の契約として残す。
 */
function searchRunway(
  flight: Flight,
  phase: "arrival" | "departure",
  ends: readonly RunwayEnd[],
  track: readonly LatLon[] | undefined,
): RunwaySelection | undefined {
  const trackDeg = finiteOrUndefined(flight.trackDeg);
  const verticalRateFpm = finiteOrUndefined(flight.verticalRateFpm);
  if (trackDeg === undefined || verticalRateFpm === undefined) {
    return undefined;
  }
  return selectRunway({ position: flight.position, trackDeg, verticalRateFpm, phase, track }, ends);
}

/**
 * evidence の各行（AC-P2-54 の書式）。
 * **高度は入れない**（通過の「巡航 35000ft」は、同じ詳細パネルの飛行状態・バッジが設定の単位（F-09・Q19）で
 * 出す同じ高度と食い違うため、W9 の全体差分レビュー MAJOR-1 で削った）。通過の根拠は「水平飛行 0fpm」で足りる
 */
function buildEvidence(args: {
  flight: Flight;
  airport: TargetAirport | undefined;
  selection: RunwaySelection | undefined;
  route: RouteBacking | undefined;
  disagreement: string | undefined;
}): string[] {
  const { flight, airport, selection, route, disagreement } = args;
  const evidence: string[] = [];

  if (selection) {
    // 方位のズレ・距離は**選ばれた端**の値（未判別なら組内で採点最小の端。AC-P3-10）
    evidence.push(`方位のズレ ${oneDecimal(selection.headingOffDeg)}°`);
    evidence.push(`滑走路まで ${oneDecimal(selection.distanceKm)}km`);
    if (selection.sideEvidence !== undefined) {
      // L/R の判別の行（並行の組のときだけ付く。AC-P3-09）は、**同じ「どの端か」の根拠**である
      // 方位のズレ・距離の直後に置き、機体の状態（昇降率）や外部データ（adsbdb）より前に出す。
      // 読む順が「滑走路を選んだ理由 → 機体の状態 → 裏付け → 食い違い」で一貫する
      evidence.push(selection.sideEvidence);
    }
  } else if (airport) {
    evidence.push(`${airportName(airport.icao)}まで ${oneDecimal(haversineKm(flight.position, airport))}km`);
  }

  const verticalRateFpm = finiteOrUndefined(flight.verticalRateFpm);
  if (verticalRateFpm !== undefined) {
    evidence.push(verticalRateEvidence(verticalRateFpm));
  }
  if (route) {
    // 空港は「羽田」（詳細の「空港」欄・他の evidence の行と同じ呼び名。W9 MINOR-3）
    evidence.push(`adsbdb: ${airportName(route.airport.icao)} ${route.phase === "departure" ? "発" : "着"}`);
  }
  if (disagreement) {
    evidence.push(disagreement);
  }
  return evidence;
}

/**
 * 「降下中 -704fpm」「上昇中 +1500fpm」「水平飛行 0fpm」。
 * 数値部分は `src/shared/estimate.ts` の `formatFpm`（丸め・-0・接尾辞。符号は付けない）。
 * 詳細パネルの「昇降率」（`src/client/lib/format.ts` の `formatVerticalRateFpm`）も同じ関数を通すので、
 * 同じ機体の根拠とこの行の数字が食い違わない。向きは語が伝えるので、符号は上昇のときだけ足す
 */
function verticalRateEvidence(fpm: number): string {
  const value = formatFpm(fpm);
  if (fpm > VERTICAL_RATE_THRESHOLD_FPM) {
    return `上昇中 +${value}`;
  }
  if (fpm < -VERTICAL_RATE_THRESHOLD_FPM) {
    return `降下中 ${value}`;
  }
  return `水平飛行 ${value}`;
}

/** 表示用の空港名（「羽田」）。evidence の中はこの呼び名で統一する。表に無い ICAO はそのまま出す（推測で埋めない） */
function airportName(icao: string): string {
  return airportDisplayName(icao)?.shortName ?? icao;
}

function findAirport(airports: readonly TargetAirport[], icao: string | undefined): TargetAirport | undefined {
  return icao === undefined ? undefined : airports.find((airport) => airport.icao === icao);
}

/** 小数 1 桁（「0.3」「10.7」）。-0 は 0 にする */
function oneDecimal(value: number): string {
  return (value === 0 ? 0 : value).toFixed(1);
}
