// 機体への adsbdb ルートの付与（AC-A13）。HTTP アプリ（`app.ts`）と運用方向の集計（`airportOpsSource.ts`）の
// **両方が使う**ので、どちらよりも下の層（`RouteInfo` の定義元と同じディレクトリ）に置く。
// ここは純粋関数だけで、HTTP フレームワーク（hono）にも I/O にも依存しない。
// （W10 MINOR-2: `app.ts` から移設。集計が `app.ts` を値 import すると、レイヤが逆向きになり、
//  集計の単体テストが hono / serve-static を読み込んでしまうため）
import type { Flight } from "../../shared/types.ts";
import type { RouteInfo } from "./enrichment.ts";

export type AttachRoutesResult = {
  /** ルートが見つかった機体はコピーに `route`（と `airline`）を付けたもの、それ以外は入力と同じオブジェクト */
  flights: Flight[];
  /** ルートが見つからなかった旅客機・貨物機のコールサイン（重複を除き、入力の順） */
  missingCallsigns: string[];
};

/**
 * 旅客機・貨物機（コールサインあり）に `getRoute` の結果を付ける（AC-A13）。入力の配列と機体オブジェクトは書き換えない。
 * `other`・コールサインの無い機体はルートを見ず、`missingCallsigns` にも入れない
 */
export function attachRoutes(
  flights: readonly Flight[],
  getRoute: (callsign: string) => RouteInfo | undefined,
): AttachRoutesResult {
  const missing = new Set<string>();
  const result = flights.map((flight) => {
    const callsign = routeCallsign(flight);
    if (callsign === undefined) return flight;
    const info = getRoute(callsign);
    if (info === undefined) {
      missing.add(callsign);
      return flight;
    }
    return withRoute(flight, info);
  });
  return { flights: result, missingCallsigns: [...missing] };
}

/** ルート・詳細 API の対象にする種類（旅客機・貨物機） */
export function isTrackedKind(kind: Flight["kind"]): boolean {
  return kind === "passenger" || kind === "cargo";
}

/** ルートを照会する対象ならコールサインを返す（旅客機・貨物機でコールサインが空でないもの） */
function routeCallsign(flight: Flight): string | undefined {
  if (!isTrackedKind(flight.kind)) return undefined;
  return flight.callsign === undefined || flight.callsign === "" ? undefined : flight.callsign;
}

function withRoute(flight: Flight, info: RouteInfo): Flight {
  return info.airline === undefined
    ? { ...flight, route: info.route }
    : { ...flight, airline: info.airline, route: info.route };
}
