# FlightBoard

指定した地点の周辺を飛んでいる旅客機・貨物機を調べる、ローカル専用の BFF（バックエンド）と、それが配信するブラウザ画面です。
BFF は公開されている ADS-B データを取得し、機体の種類・距離で絞り込んで JSON で返します。

## 必要環境

- Node.js 24

## 起動

```sh
npm install
npm start
```

`npm start` はブラウザ用の画面を `dist/client` にビルドしてから BFF を起動します。
起動すると `127.0.0.1` のポート 3000 で待ち受けます（この PC からだけ接続できます）。
ブラウザで `http://127.0.0.1:3000/` を開くと画面が表示されます。

API を直接呼ぶ場合: ブラウザか curl で次の URL を開きます（`lat`・`lon` は調べたい地点の緯度・経度）。

```sh
curl "http://127.0.0.1:3000/api/nearby?lat=35.87&lon=139.93"
```

### ポートを変える

ポート 3000 が使用中の場合は、環境変数 `PORT`（0〜65535 の整数）で変更できます。

```sh
# bash など
PORT=3001 npm start
```

```powershell
# PowerShell
$env:PORT = "3001"; npm start
```

## 検証

```sh
npm run typecheck   # 型検査
npm test            # テスト（実際の上流 API には接続しません）
npm run build       # 画面のビルド（出力は dist/client）
npm run verify      # 型検査・テスト・ビルド
```

## API

型の定義は `src/shared/types.ts`（`NearbyResponse`・`Flight`・`ApiError`）にあります。

### `GET /api/nearby`

指定した地点の周辺の機体を、近い順に返します。

| パラメータ | 必須 | 既定値 | 内容 |
|---|---|---|---|
| `lat` | 必須 | — | 検索中心の緯度（-90〜90） |
| `lon` | 必須 | — | 検索中心の経度（-180〜180） |
| `radiusKm` | 任意 | `50` | 検索半径（km、10〜100） |
| `kinds` | 任意 | `passenger,cargo` | 返す種類。`passenger`（旅客機）・`cargo`（貨物機）・`other`（その他）のカンマ区切り。大文字・小文字と前後の空白は区別せず、重複は 1 つにまとめます |

数値は 10 進表記だけを受け付けます（`1e1` のような指数表記や、前後の空白は不可）。

#### 応答（200）

```jsonc
{
  "updatedAt": "2026-09-15T00:00:00.000Z", // 位置を上流から取得し終えたサーバーの時刻（ISO 8601）
  "source": "adsblol",                     // 位置の取得元: "adsblol" | "adsbfi" | "opensky"
  "flights": [],                           // 機体（Flight）の配列。検索中心からの水平距離の昇順
  "airportOps": []                         // 現在は常に空配列
}
```

`flights` の各要素（`Flight`）の主な項目:

| 項目 | 内容 |
|---|---|
| `hex` | 機体の ICAO 24bit アドレス（16 進） |
| `callsign` | コールサイン（無ければ省略） |
| `registration` / `typeCode` | 登録記号 / 機種コード（無ければ省略。OpenSky から取得した場合は無し） |
| `position` | `lat`・`lon`・`altitudeBaroFt`（気圧高度 ft。無ければ `null`）・`altitudeGeomFt`（GNSS 高度 ft。無ければ省略）・`onGround` |
| `groundSpeedKt` / `trackDeg` / `verticalRateFpm` / `targetAltitudeFt` / `squawk` | 対地速度 kt / 進行方向（度）/ 昇降率 ft/min / 目標高度 ft / スコーク（いずれも無ければ省略） |
| `isMlat` | 位置がマルチラテレーション（MLAT）によるものか |
| `seenPosSec` | 位置の最終受信から**応答時点まで**の経過秒（`updatedAt` 基準ではありません） |
| `kind` | `passenger` / `cargo` / `other` |
| `source` | 位置の取得元 |

返す機体の条件:

- 位置の最終受信から 60 秒を超えた機体は返しません（ちょうど 60 秒は返します）
- 検索中心からの水平距離が `radiusKm` 以下の機体だけを返します
- `kinds` に含まれない種類の機体は返しません。地上にいる機体と、提供元が軍用フラグを持つ機体（adsb.lol / adsb.fi の `dbFlags`）は、`kinds` に関わらず返しません。OpenSky から取得したときは軍用フラグが無いため、軍用機はコールサインの形式により `other`（既定では返しません）として扱われます

位置の取得:

- 上流は adsb.lol → adsb.fi → OpenSky Network の順に試し、最初に取得できた提供元を使います。失敗した提供元は一定時間後回しにし、自動で次の提供元に切り替えます
- 同じ地点・半径の要求は 5 秒間キャッシュから返し、上流には問い合わせません

ルート情報（`route`・`airline`）:

- 旅客機・貨物機（コールサインあり）の出発地・目的地（`route`）と航空会社（`airline`）を付けます
- ルート情報は adsbdb からバックグラウンドで取得するため、初回応答では付かず以後の要求で付きます。取得できない便には付きません。航空会社が分からない便は `route` だけが付きます

#### エラー

エラーの応答はすべて次の形の JSON です。

```json
{ "error": "エラーの説明" }
```

| ステータス | 場合 |
|---|---|
| 400 | パラメータが不正（欠落・空値・範囲外・空要素・未知の種類など） |
| 404 | 存在しない API のパス |
| 500 | サーバー内部のエラー |
| 502 | どの提供元からも位置を取得できなかった |

### `GET /api/flights/:hex`

旅客機・貨物機 1 機の詳細（最新の位置・ルート・機種名と機体写真）と、直近の航跡を返します。
型の定義は `src/shared/types.ts`（`FlightDetailResponse`・`TrackPoint`）にあります。

```sh
curl "http://127.0.0.1:3000/api/flights/86d7a4"
```

| パラメータ | 内容 |
|---|---|
| `hex` | 機体の ICAO 24bit アドレス（`/api/nearby` の `hex`）。6 桁の 16 進で、ICAO アドレスでない機体は先頭に `~` が付きます。大文字・小文字は区別しません（小文字にしてから検証します） |

航跡は、`/api/nearby` の要求で位置を上流から取得するたびに（キャッシュから返したときは除く）、取得した旅客機・貨物機について記録します。

- 直前の点と同じ位置は記録しません
- 直近 10 分・1 機あたり最大 60 点を保持します（古い点から削除します）
- 10 分間位置を取得していない機体は破棄します。サーバーを再起動すると消えます

#### 応答（200）

```jsonc
{
  "updatedAt": "2026-09-15T00:00:00.000Z", // この機体を含む位置を最後に上流から取得し終えたサーバーの時刻（ISO 8601）
  "flight": {},                            // 機体（Flight）。項目は /api/nearby の flights の要素と同じ
  "track": [                               // 航跡（TrackPoint）の配列。古い順
    { "lat": 35.8, "lon": 139.9, "altitudeFt": 10000, "at": "2026-09-15T00:00:00.000Z" }
  ]
}
```

`track` の各点（`TrackPoint`）:

| 項目 | 内容 |
|---|---|
| `lat` / `lon` | 緯度・経度 |
| `altitudeFt` | 高度 ft（GNSS 高度を優先し、無ければ気圧高度。どちらも無ければ `null`） |
| `at` | その位置を受信した時刻（ISO 8601）。位置を取得した時刻から、その時点の `seenPosSec` を引いたもの |

`flight` について:

- `seenPosSec` は位置の最終受信から**応答時点まで**の経過秒です（`/api/nearby` と同じく、位置を取得してから応答までの経過秒を足した値）
- `route`・`airline` は adsbdb から取得済みの便にだけ付きます（未取得ならバックグラウンドで取得を始め、以後の要求で付きます）
- `aircraft` は adsbdb の機体情報で、`model`（機種名。例 `Boeing 787 9`）と `photo`（機体写真。`url`・`thumbnailUrl`・`credit`（出典））を持ちます。それぞれ無ければ省略します。機体情報を取得できなかった場合は `aircraft` を省略して 200 を返します

#### エラー

| ステータス | 場合 |
|---|---|
| 400 | `hex` が不正（小文字にした後で `^~?[0-9a-f]{6}$` に一致しない） |
| 404 | その機体を保持していない（記録していない・10 分間更新が無く破棄した）、位置の最終受信から 60 秒を超えた、旅客機・貨物機でない |
| 500 | サーバー内部のエラー |

## データ提供元

- [adsb.lol](https://adsb.lol) — データは [Open Database License (ODbL) 1.0](https://opendatacommons.org/licenses/odbl/1-0/) で提供されています
- [adsb.fi](https://adsb.fi)
- [The OpenSky Network](https://opensky-network.org)
- [adsbdb](https://www.adsbdb.com)
- 機体写真: airport-data.com（adsbdb 経由）

## 注意

経路の表示は推定です。航行や安全の判断には使わないでください。
