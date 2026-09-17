// npm run import-runways -- <runways.csv のパス>
// OurAirports の runways.csv（パブリックドメイン、https://ourairports.com/data/）から
// src/server/data/runways.ts を生成し直す。CSV の解釈と生成するソースの組み立ては
// src/server/data/importRunways.ts の純粋関数に置き、ここは入出力の配線だけにする。
import { readFileSync, writeFileSync } from "node:fs";
import { basename } from "node:path";
import { fileURLToPath } from "node:url";
import { TARGET_AIRPORT_ICAOS } from "../server/data/airports.ts";
import { importRunwayEnds, renderRunwaysModule } from "../server/data/importRunways.ts";

const source = process.argv[2];
if (source === undefined) {
  console.error("使い方: npm run import-runways -- <runways.csv のパス>");
  console.error("CSV は OurAirports のデータ配布（https://ourairports.com/data/）の runways.csv");
  process.exit(1);
}

let csv: string;
try {
  csv = readFileSync(source, "utf-8");
} catch (error) {
  console.error(`CSV を読めませんでした: ${source}`);
  console.error(error);
  process.exit(1);
}

let ends: ReturnType<typeof importRunwayEnds>["ends"];
let warnings: readonly string[];
let lengthMismatches: ReturnType<typeof importRunwayEnds>["lengthMismatches"];
try {
  ({ ends, warnings, lengthMismatches } = importRunwayEnds(csv, TARGET_AIRPORT_ICAOS));
} catch (error) {
  console.error(`CSV を取り込めませんでした: ${source}`);
  console.error(error);
  process.exit(1);
}

for (const warning of warnings) {
  console.warn(`警告: ${warning}`);
}
// AC-P2-03 の既知の不一致。生成物のヘッダと KNOWN_LENGTH_MISMATCHES に記録するので、ここでは知らせるだけ
for (const mismatch of lengthMismatches) {
  console.warn(
    `既知の不一致: ${mismatch.icao} ${mismatch.ident}/${mismatch.oppositeIdent} — ` +
      `端間 ${mismatch.endsApartKm.toFixed(3)}km / 公示 ${mismatch.publishedKm.toFixed(3)}km` +
      `（${(mismatch.deviation * 100).toFixed(1)}%）`,
  );
}
if (ends.length === 0) {
  console.error(`対象空港（${TARGET_AIRPORT_ICAOS.join(", ")}）の滑走路が 1 本もありませんでした: ${source}`);
  process.exit(1);
}

// 出力先は作業ディレクトリに依存しないよう、このファイルの位置から決める
const output = fileURLToPath(new URL("../server/data/runways.ts", import.meta.url));
const generatedAt = new Date().toISOString().slice(0, 10);
writeFileSync(
  output,
  renderRunwaysModule(ends, { sourceName: basename(source), generatedAt, warnings, lengthMismatches }),
  "utf-8",
);

const airports = [...new Set(ends.map((end) => end.icao))].join(", ");
console.log(
  `${output} を更新しました（${airports} の滑走路端 ${ends.length} 本、警告 ${warnings.length} 件、` +
    `既知の不一致 ${lengthMismatches.length} 件）`,
);
