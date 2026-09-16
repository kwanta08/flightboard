// 詳細パネルの表示の判断と文言（AC-B12・AC-B13、F-05・S-03）。単位は m・km/h 固定。
// DetailPanel.tsx はこの結果を描画するだけにする。取得状態の遷移は lib/detailState.ts、
// 「経路」の区分（推定）の文言は lib/estimateView.ts。
import {
  aircraftAltitudeM,
  bearingDeg,
  bearingToJa16,
  elevationAngleDeg,
  haversineKm,
  slantDistanceKm,
  type LatLon,
} from "../../shared/geo.ts";
import type { Airport, AirportOps, Flight, FlightDetailResponse } from "../../shared/types.ts";
import { detailBody, type DetailState } from "./detailState.ts";
import { buildEstimateSection, ESTIMATE_ITEM_LABELS, ESTIMATE_SECTION_TITLE } from "./estimateView.ts";
import type { Observer } from "./flightRows.ts";
import {
  DASH,
  finiteOrUndefined,
  formatAltitudeFt,
  formatBearing,
  formatDistanceKm,
  formatElevationDeg,
  formatSpeedKt,
  formatVerticalRateFpm,
  isFiniteNumber,
  nonEmpty,
  type MaybeNumber,
} from "./format.ts";
import { typeDisplayName } from "./typeNames.ts";

// ---- 文言 ----

/** パネル（`<aside>`）のアクセシブルネーム。詳細がまだ無いときの見出しにも使う */
export const DETAIL_PANEL_LABEL = "機体の詳細";

/** 閉じるボタンの文字とアクセシブルネーム */
export const DETAIL_CLOSE_TEXT = "閉じる";
export const DETAIL_CLOSE_LABEL = "詳細を閉じる";

/** 詳細がまだ無く取得中のとき */
export const DETAIL_LOADING_MESSAGE = "詳細を取得しています…";

/** 詳細が無いまま取得に失敗したとき */
export const DETAIL_ERROR_MESSAGE = "詳細を取得できませんでした";

/** 詳細を表示中に取り直しが失敗したとき（前回の詳細を出したまま添える） */
export const DETAIL_REFRESH_FAILED_MESSAGE = "詳細を更新できませんでした（前回取得した内容を表示しています）";

/** 404 のとき（AC-B12 の文のまま） */
export const DETAIL_NOT_FOUND_MESSAGE = "この機体の情報を取得できません（範囲外に出た可能性があります）";

/** ルートの注記（AC-B12「ルートは adsbdb による推定」） */
export const ROUTE_NOTE = "ルートは adsbdb による推定です";

/** 「ルートの信頼度」の値。adsbdb は確度を返さないので固定の表示で代える（plan p1b「仮決めした解釈」） */
export const ROUTE_CONFIDENCE_TEXT = "adsbdb による推定";

/** 進み具合のバーのアクセシブルネーム */
export const ROUTE_PROGRESS_LABEL = "進み具合";

/** 写真のクレジットの頭（撮影者名の無い写真は出さない。仕様 §13） */
export const PHOTO_CREDIT_PREFIX = "写真: ";

/** F-05 の区分。「経路」（推定）は Phase 2 で末尾に足した（AC-P2-53。文言は lib/estimateView.ts） */
export const DETAIL_SECTION_TITLES = {
  flight: "フライト",
  aircraft: "機体",
  state: "飛行状態",
  relation: "自分との関係",
  estimate: ESTIMATE_SECTION_TITLE,
} as const;

/** 各区分の項目名 */
export const DETAIL_ITEM_LABELS = {
  callsign: "便名",
  airline: "航空会社",
  origin: "出発地",
  destination: "到着地",
  routeConfidence: "ルートの信頼度",
  model: "機種名",
  registration: "登録記号",
  icaoAddress: "ICAO 24bit アドレス",
  altitudeBaro: "気圧高度",
  altitudeGeom: "GNSS 高度",
  groundSpeed: "対地速度",
  track: "進行方向",
  verticalRate: "昇降率",
  targetAltitude: "目標高度",
  squawk: "スコーク",
  horizontalDistance: "水平距離",
  slantDistance: "直線距離",
  bearing: "方角",
  elevation: "仰角",
  ...ESTIMATE_ITEM_LABELS,
} as const;

// ---- 表示の型 ----

export type DetailItem = { label: string; value: string };

/** 区分に添える補足の一覧（見出しと行）。「経路」の区分では「根拠」と `estimate.evidence` の各行 */
export type DetailNotes = { label: string; lines: string[] };

export type DetailSection = {
  title: string;
  items: DetailItem[];
  /** 項目名の無い補足の行（「経路」の区分では `estimate.evidence` の各行）。無ければ省く */
  notes?: DetailNotes;
};

export type DetailPhoto = {
  /** 表示する画像（`url` 優先、無ければ `thumbnailUrl`） */
  src: string;
  /** 「<便名> の機体写真」 */
  alt: string;
  /** 「写真: <撮影者名>」 */
  credit: string;
  /** クレジットからたどる写真ページ（提供元の規約で必要） */
  link: string;
};

export type DetailRoute = {
  originLabel: string;
  destinationLabel: string;
  /** 出発地から現在位置までの距離 ÷（それ＋現在位置から到着地まで）を [0, 1] に丸めた値。出発地・到着地の座標が両方あるときだけ */
  progress?: number;
  /** 「約 N%」（`progress` があるときだけ） */
  progressText?: string;
  note: typeof ROUTE_NOTE;
};

export type DetailView = {
  /** 便名（無ければ hex） */
  title: string;
  /** 航空会社名。無ければ無し（見出しの下に「—」だけの副見出しを出さない） */
  subtitle?: string;
  photo?: DetailPhoto;
  route?: DetailRoute;
  sections: DetailSection[];
};

// ---- 値の書式 ----

/** 進行方向（度）を「123°（東南東）」の形に。度は整数に丸めて [0, 360) にし、16 方位は丸めた値から求める。値が無ければ「—」 */
export function formatHeadingDeg(deg: MaybeNumber): string {
  if (!isFiniteNumber(deg)) {
    return DASH;
  }
  const whole = ((Math.round(deg) % 360) + 360) % 360;
  return `${whole}°（${bearingToJa16(whole) ?? DASH}）`;
}

/**
 * 空港の表示。IATA（無ければ ICAO）＋空白＋空港名（あれば）＋都市名（あれば全角の括弧で）。
 * 例 { icao: "RJTT", iata: "HND", name: "Tokyo Haneda International Airport", municipality: "Tokyo" }
 * → 「HND Tokyo Haneda International Airport（Tokyo）」
 */
export function airportLabel(airport: Pick<Airport, "icao" | "iata" | "name" | "municipality">): string {
  const code = nonEmpty(airport.iata) ?? airport.icao.trim();
  const name = nonEmpty(airport.name);
  const city = nonEmpty(airport.municipality);
  const base = name === undefined ? code : `${code} ${name}`;
  return city === undefined ? base : `${base}（${city}）`;
}

/** [0, 1] に丸める */
function clampUnit(value: number): number {
  return Math.min(1, Math.max(0, value));
}

/**
 * 進み具合。出発地から現在位置までの距離 ÷（出発地から現在位置 ＋ 現在位置から到着地）を [0, 1] に丸める。
 * 出発地・到着地の座標のどれかが無い（非有限）、または比が求まらない（出発地・到着地・現在位置がすべて同じ点）なら undefined
 */
export function routeProgress(
  origin: Pick<Airport, "lat" | "lon">,
  current: LatLon,
  destination: Pick<Airport, "lat" | "lon">,
): number | undefined {
  if (
    !isFiniteNumber(origin.lat) ||
    !isFiniteNumber(origin.lon) ||
    !isFiniteNumber(destination.lat) ||
    !isFiniteNumber(destination.lon)
  ) {
    return undefined;
  }
  const fromOrigin = haversineKm({ lat: origin.lat, lon: origin.lon }, current);
  const toDestination = haversineKm(current, { lat: destination.lat, lon: destination.lon });
  const ratio = fromOrigin / (fromOrigin + toDestination);
  return Number.isFinite(ratio) ? clampUnit(ratio) : undefined;
}

/** 進み具合の文字（「約 N%」、N は整数に丸める） */
export function progressText(progress: number): string {
  return `約 ${Math.round(progress * 100)}%`;
}

/** 観測者から見た機体の位置関係 */
export type ObserverRelation = {
  /** 水平距離（km） */
  horizontalKm: number;
  /** 直線距離（km）。機体の高度が無ければ undefined */
  slantKm?: number;
  /** 観測者から見た方位（度） */
  bearingDeg: number;
  /** 仰角（度）。機体の高度が無ければ undefined */
  elevationDeg?: number;
};

/** 観測者の地点・標高から見た機体の水平距離・直線距離・方位・仰角（§11）。機体の高度は GNSS 高度を優先する */
export function observerRelation(position: Flight["position"], observer: Observer): ObserverRelation {
  const target = { lat: position.lat, lon: position.lon };
  const horizontalKm = haversineKm(observer, target);
  const altitudeM = finiteOrUndefined(aircraftAltitudeM(position));
  const relation: ObserverRelation = { horizontalKm, bearingDeg: bearingDeg(observer, target) };
  if (altitudeM === undefined || !isFiniteNumber(horizontalKm)) {
    return relation;
  }
  const geometry = { horizontalKm, observerAltitudeM: observer.elevationM, targetAltitudeM: altitudeM };
  const slantKm = finiteOrUndefined(slantDistanceKm(geometry));
  const elevationDeg = finiteOrUndefined(elevationAngleDeg(geometry));
  return {
    ...relation,
    ...(slantKm === undefined ? {} : { slantKm }),
    ...(elevationDeg === undefined ? {} : { elevationDeg }),
  };
}

/** 写真の URL として使えるか（http・https の絶対 URL だけを通す） */
function isHttpUrl(text: string): boolean {
  try {
    const { protocol } = new URL(text);
    return protocol === "https:" || protocol === "http:";
  } catch {
    return false;
  }
}

function photoUrl(text: string | undefined): string | undefined {
  const url = nonEmpty(text);
  return url !== undefined && isHttpUrl(url) ? url : undefined;
}

/** 撮影者名・写真ページのリンク・http(s) の画像 URL が揃っている写真だけを出す（仕様 §13） */
function buildPhoto(photo: NonNullable<Flight["aircraft"]>["photo"], title: string): DetailPhoto | undefined {
  if (photo === undefined) {
    return undefined;
  }
  const src = photoUrl(photo.url) ?? photoUrl(photo.thumbnailUrl);
  const credit = nonEmpty(photo.credit);
  const link = photoUrl(photo.link);
  if (src === undefined || credit === undefined || link === undefined) {
    return undefined;
  }
  return { src, alt: `${title} の機体写真`, credit: `${PHOTO_CREDIT_PREFIX}${credit}`, link };
}

function buildRoute(route: NonNullable<Flight["route"]>, current: LatLon): DetailRoute {
  const progress = routeProgress(route.origin, current, route.destination);
  return {
    originLabel: airportLabel(route.origin),
    destinationLabel: airportLabel(route.destination),
    ...(progress === undefined ? {} : { progress, progressText: progressText(progress) }),
    note: ROUTE_NOTE,
  };
}

/**
 * 詳細パネルに出す内容（F-05 の区分。値の無い項目は「—」）。
 * `airportOps` は「経路」の区分の「運用方向」に使う（無ければその項目は「—」）
 */
export function buildDetailView(
  detail: FlightDetailResponse,
  observer: Observer,
  airportOps?: readonly AirportOps[],
): DetailView {
  const { flight } = detail;
  const labels = DETAIL_ITEM_LABELS;
  const callsign = nonEmpty(flight.callsign);
  const title = callsign ?? flight.hex;
  const airlineName = nonEmpty(flight.airline?.name);
  const route = flight.route === undefined ? undefined : buildRoute(flight.route, flight.position);
  const photo = buildPhoto(flight.aircraft?.photo, title);
  const relation = observerRelation(flight.position, observer);

  const sections: DetailSection[] = [
    {
      title: DETAIL_SECTION_TITLES.flight,
      items: [
        { label: labels.callsign, value: callsign ?? DASH },
        { label: labels.airline, value: airlineName ?? DASH },
        { label: labels.origin, value: route?.originLabel ?? DASH },
        { label: labels.destination, value: route?.destinationLabel ?? DASH },
        { label: labels.routeConfidence, value: route === undefined ? DASH : ROUTE_CONFIDENCE_TEXT },
      ],
    },
    {
      title: DETAIL_SECTION_TITLES.aircraft,
      items: [
        { label: labels.model, value: nonEmpty(flight.aircraft?.model) ?? typeDisplayName(flight.typeCode) },
        { label: labels.registration, value: nonEmpty(flight.registration) ?? DASH },
        { label: labels.icaoAddress, value: nonEmpty(flight.hex)?.toUpperCase() ?? DASH },
      ],
    },
    {
      title: DETAIL_SECTION_TITLES.state,
      items: [
        { label: labels.altitudeBaro, value: formatAltitudeFt(flight.position.altitudeBaroFt) },
        { label: labels.altitudeGeom, value: formatAltitudeFt(flight.position.altitudeGeomFt) },
        { label: labels.groundSpeed, value: formatSpeedKt(flight.groundSpeedKt) },
        { label: labels.track, value: formatHeadingDeg(flight.trackDeg) },
        { label: labels.verticalRate, value: formatVerticalRateFpm(flight.verticalRateFpm) },
        { label: labels.targetAltitude, value: formatAltitudeFt(flight.targetAltitudeFt) },
        { label: labels.squawk, value: nonEmpty(flight.squawk) ?? DASH },
      ],
    },
    {
      title: DETAIL_SECTION_TITLES.relation,
      items: [
        { label: labels.horizontalDistance, value: formatDistanceKm(relation.horizontalKm) },
        { label: labels.slantDistance, value: formatDistanceKm(relation.slantKm) },
        {
          label: labels.bearing,
          value: isFiniteNumber(relation.horizontalKm) ? formatBearing(relation.bearingDeg) : DASH,
        },
        { label: labels.elevation, value: formatElevationDeg(relation.elevationDeg) },
      ],
    },
  ];

  // 「経路」は推定のある機体だけ、区分の末尾に足す（AC-P2-53）
  const estimateSection = buildEstimateSection(flight.estimate, airportOps);
  if (estimateSection !== undefined) {
    sections.push(estimateSection);
  }

  return {
    title,
    ...(airlineName === undefined ? {} : { subtitle: airlineName }),
    ...(photo === undefined ? {} : { photo }),
    ...(route === undefined ? {} : { route }),
    sections,
  };
}

// ---- パネル ----

/** パネルの中身。`message` は詳細が無いときの案内、`notice` は詳細を出したまま添える案内、`view` は詳細 */
export type DetailPanelContent = {
  title: string;
  subtitle?: string;
  message?: string;
  notice?: string;
  view?: DetailView;
};

/**
 * パネルに出すもの（`detailBody` の種類ごと）。
 * loading・not-found・error は見出し「機体の詳細」と案内の文、view は詳細（便名を見出しに、航空会社名があれば副見出しに）。
 * 最後の結果があれば取り直し中もその結果を出す（404・失敗の案内も詳細も「詳細を取得しています…」に戻さない。取得中の案内は結果が無いときだけ）。
 * 詳細を出している間の取り直しでは何も添えず（ちらつかない）、最後の取得が失敗しているときだけ `notice` を添える
 */
export function detailPanelContent(
  state: DetailState,
  observer: Observer,
  airportOps?: readonly AirportOps[],
): DetailPanelContent {
  const body = detailBody(state);
  switch (body.kind) {
    case "empty":
      return { title: DETAIL_PANEL_LABEL };
    case "loading":
      return { title: DETAIL_PANEL_LABEL, message: DETAIL_LOADING_MESSAGE };
    case "not-found":
      return { title: DETAIL_PANEL_LABEL, message: DETAIL_NOT_FOUND_MESSAGE };
    case "error":
      return { title: DETAIL_PANEL_LABEL, message: DETAIL_ERROR_MESSAGE };
    case "view": {
      const view = buildDetailView(body.detail, observer, airportOps);
      return {
        title: view.title,
        ...(view.subtitle === undefined ? {} : { subtitle: view.subtitle }),
        ...(state.status === "error" ? { notice: DETAIL_REFRESH_FAILED_MESSAGE } : {}),
        view,
      };
    }
  }
}

/** パネル内で押すと詳細を閉じるキー（AC-B8。一覧の Esc と同じ） */
export function isCloseKey(key: string): boolean {
  return key === "Escape";
}
