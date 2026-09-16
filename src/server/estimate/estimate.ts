// 推定の組み立て（docs/spec.md §10.2、plan の「estimate の生成規則と confidence 表」）。
// フェーズ判定（phase.ts）と滑走路の採点（runway.ts）を束ね、Flight["estimate"] を作る純粋関数。
// 入力は単発の Flight だけで、航跡・I/O・グローバル状態は使わない。
import { airportDisplayName } from "../../shared/airports.ts";
import { aircraftAltitudeFt, haversineKm } from "../../shared/geo.ts";
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
import { type RunwayCandidate, selectRunway } from "./runway.ts";

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
 * - 通過 → estimate あり（airport・runway なし、0.5）
 * - 不明 かつ 滑走路なし → undefined（推定を付けない）
 */
export function buildEstimate(
  flight: Flight,
  ends: readonly RunwayEnd[] = RUNWAY_ENDS,
  airports: readonly TargetAirport[] = TARGET_AIRPORTS,
): Flight["estimate"] | undefined {
  const geometry = detectPhase(flight, airports);
  const route = routeBacking(flight, geometry, airports);
  // 最終的な phase は route 由来にし、滑走路の候補探索もその phase の条件で行う（AC-P2-14 / 19）
  const phase = route?.phase ?? geometry.phase;

  // 候補探索は対象空港の滑走路端だけを見る（ends と airports で見る空港が食い違わないようにする）
  const targetEnds = ends.filter((end) => airports.some((airport) => airport.icao === end.icao));
  const candidate = phase === "arrival" || phase === "departure" ? searchRunway(flight, phase, targetEnds) : undefined;
  const runwayAirport = candidate ? findAirport(airports, candidate.end.icao) : undefined;
  // 滑走路が決まればその空港。決まらなければ route の裏付け → 接近／離脱と判定した空港の順
  const airport = phase === "enroute" ? undefined : (runwayAirport ?? route?.airport ?? geometry.airport);

  const disagreement = describeDisagreement(route, geometry, runwayAirport ?? geometry.airport);
  const rawConfidence = baseConfidence(phase, candidate, route);
  if (rawConfidence === undefined) {
    return undefined; // phase = "unknown" かつ滑走路なし
  }

  const estimate: Estimate = {
    phase,
    confidence: disagreement ? applyDisagreementPenalty(rawConfidence) : rawConfidence,
    evidence: buildEvidence({ flight, phase, airport, candidate, route, disagreement }),
  };
  if (airport) {
    estimate.airport = { icao: airport.icao, name: airportName(airport.icao) };
  }
  if (candidate) {
    estimate.runway = candidate.end.ident;
  }
  return estimate;
}

/** 食い違いの減点（素点 − 0.2、下限 0.1）。小数の丸め誤差を残さないよう小数 2 桁に丸める */
export function applyDisagreementPenalty(confidence: number): number {
  return Math.max(MIN_CONFIDENCE, Math.round((confidence - DISAGREEMENT_PENALTY) * 100) / 100);
}

/** confidence の素点。undefined なら推定を付けない（不明 かつ 滑走路なし） */
function baseConfidence(
  phase: FlightPhase,
  candidate: RunwayCandidate | undefined,
  route: RouteBacking | undefined,
): number | undefined {
  if (candidate) {
    if (candidate.headingOffDeg < STRONG_HEADING_OFF_DEG && candidate.distanceKm < STRONG_DISTANCE_KM) {
      return CONFIDENCE_RUNWAY_STRONG;
    }
    if (candidate.headingOffDeg < candidate.toleranceDeg * MEDIUM_TOLERANCE_RATIO) {
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

/** route の裏付けと幾何判定の食い違い（AC-P2-14）。食い違わなければ undefined */
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
  const airportText = geometryAirport && geometryAirport.icao !== route.airport.icao ? geometryAirport.icao : undefined;
  if (phaseText === undefined && airportText === undefined) {
    return undefined;
  }
  return `幾何判定は ${[airportText, phaseText].filter((part) => part !== undefined).join(" ")}`;
}

/** 滑走路の候補探索。進行方向・昇降率が欠けていれば探索しない（AC-P2-15） */
function searchRunway(
  flight: Flight,
  phase: "arrival" | "departure",
  ends: readonly RunwayEnd[],
): RunwayCandidate | undefined {
  const trackDeg = finiteOrUndefined(flight.trackDeg);
  const verticalRateFpm = finiteOrUndefined(flight.verticalRateFpm);
  if (trackDeg === undefined || verticalRateFpm === undefined) {
    return undefined;
  }
  return selectRunway({ position: flight.position, trackDeg, verticalRateFpm, phase }, ends);
}

/** evidence の各行（AC-P2-54 の書式） */
function buildEvidence(args: {
  flight: Flight;
  phase: FlightPhase;
  airport: TargetAirport | undefined;
  candidate: RunwayCandidate | undefined;
  route: RouteBacking | undefined;
  disagreement: string | undefined;
}): string[] {
  const { flight, phase, airport, candidate, route, disagreement } = args;
  const evidence: string[] = [];

  if (candidate) {
    evidence.push(`方位のズレ ${oneDecimal(candidate.headingOffDeg)}°`);
    evidence.push(`滑走路まで ${oneDecimal(candidate.distanceKm)}km`);
  } else if (airport) {
    evidence.push(`${airportName(airport.icao)}まで ${oneDecimal(haversineKm(flight.position, airport))}km`);
  } else if (phase === "enroute") {
    evidence.push(`巡航 ${Math.round(aircraftAltitudeFt(flight.position) ?? 0)}ft`);
  }

  const verticalRateFpm = finiteOrUndefined(flight.verticalRateFpm);
  if (verticalRateFpm !== undefined) {
    evidence.push(verticalRateEvidence(verticalRateFpm));
  }
  if (route) {
    evidence.push(`adsbdb: ${route.airport.icao} ${route.phase === "departure" ? "発" : "着"}`);
  }
  if (disagreement) {
    evidence.push(disagreement);
  }
  return evidence;
}

/** 「降下中 -704fpm」「上昇中 +1500fpm」「水平飛行 0fpm」 */
function verticalRateEvidence(fpm: number): string {
  const rounded = Math.round(fpm);
  if (fpm > VERTICAL_RATE_THRESHOLD_FPM) {
    return `上昇中 +${rounded}fpm`;
  }
  if (fpm < -VERTICAL_RATE_THRESHOLD_FPM) {
    return `降下中 ${rounded}fpm`;
  }
  return `水平飛行 ${rounded === 0 ? 0 : rounded}fpm`;
}

/** 表示用の空港名（「羽田」）。表に無い ICAO はそのまま出す（推測で埋めない） */
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
