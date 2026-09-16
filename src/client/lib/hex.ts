// 機体の hex（ICAO 24 ビットアドレス）の比較。上流の hex は小文字だが、URL・入力の経路で大文字が混じっても同じ機体として扱う。
// 依存を持たない小さな lib にして、一覧（listView）・地図（mapView）・詳細（detailState）のどこから使っても循環 import にならないようにする。

/** hex が同じ機体か（大文字小文字を区別しない） */
export function sameHex(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}
