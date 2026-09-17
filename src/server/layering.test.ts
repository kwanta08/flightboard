// 層の向きを縛るテスト（値 import のグラフを静的に走査する）。
//
// Phase 2 で同じ向き違反が 2 回出た（W3 MINOR-1: `airportOpsSource.ts` が `app.ts` から
// `MAX_SEEN_POS_SEC` を値 import / 全体差分レビュー MINOR-2: 同じファイルが `app.ts` から
// `attachRoutes` を値 import）。どちらも実行時の循環が「`app.ts` 側が `import type` である」ことだけに
// 支えられていて、型検査もテストもそれを縛っていなかった。ここでその走査を常設する。
//
// 縛る性質:
// - 運用方向の集計（`airportOpsSource.ts`）から**値 import で**到達できるモジュールに `app.ts` が無い
// - 同じ到達集合に外部パッケージ（hono / @hono/node-server など）が無い
//   （＝集計の単体テストが HTTP フレームワークを読み込まない）
//
// `import type` と値 import の区別が要点なので、走査そのものの単体テストも下に置いてある。
import { existsSync, readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SERVER_DIR = fileURLToPath(new URL(".", import.meta.url));
const REPO_ROOT = resolve(SERVER_DIR, "../..");

/** import / export …… from の 1 件。`kind` が `"type"` なら実行時の依存にならない */
type ModuleEdge = { specifier: string; kind: "value" | "type" };

/**
 * `import type X from "m"` / `export type … from "m"` だけを型 import とみなす。
 *
 * 中括弧の中だけに `type` が付く形（`import { type Foo, bar }`）は**値 import 扱い**にする。
 * `bar` のような値の束縛が混ざっていれば当然だが、`import { type Foo }` のように全部が
 * inline type でも値扱いにする ―― 型を落とすだけの実行系（tsx / node --experimental-strip-types）や
 * `verbatimModuleSyntax` ではモジュール本体が評価されるので、実行時の辺として残りうるため。
 * 層を跨ぐ型だけが欲しいときは `import type` と書けばよい（既存コードは全てそう書いてある）。
 */
const IMPORT_FROM = /^(?:import|export)\s+(type\b\s*)?[\s\S]*?\s*from\s*["']([^"']+)["']\s*;?$/;
/** 副作用だけの import（`import "./x.ts";`）。値の束縛は無いがモジュールは評価されるので値辺 */
const SIDE_EFFECT_IMPORT = /^import\s*["']([^"']+)["']\s*;?$/;

function parseDeclaration(text: string): ModuleEdge | null {
  const sideEffect = SIDE_EFFECT_IMPORT.exec(text);
  if (sideEffect !== null) return { specifier: sideEffect[1], kind: "value" };
  const fromClause = IMPORT_FROM.exec(text);
  if (fromClause === null) return null;
  return { specifier: fromClause[2], kind: fromClause[1] === undefined ? "value" : "type" };
}

/** 宣言の始まり（行頭・字下げ無し）。`export function` / `export type Foo = {` などは辿らない */
const DECLARATION_START = /^import\b|^export\s+(?:type\s+)?[*{]/;

function braceBalance(text: string): number {
  let balance = 0;
  for (const character of text) {
    if (character === "{") balance += 1;
    else if (character === "}") balance -= 1;
  }
  return balance;
}

/**
 * ソースから import / export …… from を拾う。
 *
 * ESM の静的 import は必ず最上位なので、**行頭（字下げ無し）の `import` / `export`** だけを見る。
 * こうすれば `// import { x } from "./y.ts"` のような行コメントや、字下げされた本文中の文字列は拾わない
 * （ブロックコメント（JSDoc）の中は行頭でも読み飛ばす）。
 * 複数行に跨る宣言は中括弧が閉じるまで繋げる。閉じないまま終わったら黙らずに投げる。
 *
 * 既知の割り切り: 複数行のテンプレートリテラルの中に**字下げ無しで** `import …` と書くと拾ってしまう。
 * src/server/ 配下にそういう記述は無く、誤検出は「余分な辺が増える」＝検査が厳しくなる側に倒れる。
 */
function scanModuleEdges(source: string): ModuleEdge[] {
  const edges: ModuleEdge[] = [];
  let inBlockComment = false;
  let pending: string | null = null;
  for (const raw of source.split("\n")) {
    const line = raw.trim();
    if (inBlockComment) {
      if (line.includes("*/")) inBlockComment = false;
      continue;
    }
    if (pending === null) {
      if (line.startsWith("/*")) {
        inBlockComment = !line.includes("*/");
        continue;
      }
      if (!DECLARATION_START.test(raw)) continue;
      pending = line;
    } else {
      pending = `${pending} ${line}`;
    }
    if (braceBalance(pending) > 0) continue;
    const edge = parseDeclaration(pending);
    if (edge !== null) edges.push(edge);
    pending = null;
  }
  if (pending !== null) throw new Error(`import 宣言を読み切れませんでした: ${pending.slice(0, 120)}`);
  return edges;
}

function resolveRelative(fromFile: string, specifier: string): string {
  const base = resolve(dirname(fromFile), specifier);
  for (const candidate of [base, `${base}.ts`, `${base}/index.ts`]) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(`相対 import を解決できません: ${specifier}（${display(fromFile)}）`);
}

function display(file: string): string {
  return relative(REPO_ROOT, file).replaceAll("\\", "/");
}

type Reachable = {
  /** 値 import で到達できるモジュール（起点を含む。リポジトリルートからの相対パス） */
  modules: string[];
  /** 値 import で到達できる外部パッケージ（`node:*` を含む。import 指定子そのまま） */
  packages: string[];
};

/** 起点から**値 import だけ**を辿って到達できるモジュールと外部パッケージを集める */
function valueReachableFrom(entryFile: string): Reachable {
  const modules = new Set<string>();
  const packages = new Set<string>();
  const queue = [entryFile];
  const seen = new Set(queue);
  while (queue.length > 0) {
    const file = queue.pop() as string;
    modules.add(display(file));
    for (const edge of scanModuleEdges(readFileSync(file, "utf-8"))) {
      if (edge.kind === "type") continue;
      if (!edge.specifier.startsWith(".")) {
        packages.add(edge.specifier);
        continue;
      }
      const target = resolveRelative(file, edge.specifier);
      if (seen.has(target)) continue;
      seen.add(target);
      queue.push(target);
    }
  }
  return { modules: [...modules].sort(), packages: [...packages].sort() };
}

const AIRPORT_OPS_SOURCE = resolve(SERVER_DIR, "airportOpsSource.ts");
const APP = resolve(SERVER_DIR, "app.ts");

describe("値 import の到達集合", () => {
  const fromAirportOps = valueReachableFrom(AIRPORT_OPS_SOURCE);

  it("走査が実際にグラフを辿っている（空振りで下の検査が素通りしない）", () => {
    // 集計の実体と、`app.ts` から移設した純粋関数には値 import で到達するはず
    expect(fromAirportOps.modules).toContain("src/server/estimate/airportOps.ts");
    expect(fromAirportOps.modules).toContain("src/server/adsbdb/attachRoutes.ts");
    expect(fromAirportOps.modules.length).toBeGreaterThan(5);
  });

  it("値 import は検出できている（app.ts からは hono へ到達する）", () => {
    // 逆向きの確認。これが落ちるなら走査が値 import を取りこぼしている
    expect(valueReachableFrom(APP).packages).toContain("hono");
  });

  it("airportOpsSource.ts から app.ts へ値 import で到達しない（レイヤの向き）", () => {
    // `import type { AppTracks } from "./app.ts"` は許す。値を 1 つでも取ると実行時の循環になり、
    // `app.ts` 側が `airportOpsSource.ts` の値を使った瞬間に壊れる
    expect(fromAirportOps.modules).not.toContain("src/server/app.ts");
  });

  it("airportOpsSource.ts から HTTP フレームワークへ到達しない", () => {
    const http = fromAirportOps.packages.filter(
      (name) => name === "hono" || name.startsWith("hono/") || name.startsWith("@hono/"),
    );
    expect(http).toEqual([]);
  });

  it("airportOpsSource.ts は外部パッケージを一切読み込まない（集計は純粋関数とデータだけ）", () => {
    expect(fromAirportOps.packages).toEqual([]);
  });
});

describe("scanModuleEdges", () => {
  it("import type を値 import と取り違えない", () => {
    expect(scanModuleEdges('import type { AppTracks } from "./app.ts";')).toEqual([
      { specifier: "./app.ts", kind: "type" },
    ]);
    expect(scanModuleEdges('import type AppTracks from "./app.ts";')).toEqual([
      { specifier: "./app.ts", kind: "type" },
    ]);
    expect(scanModuleEdges('import { attachRoutes } from "./app.ts";')).toEqual([
      { specifier: "./app.ts", kind: "value" },
    ]);
    expect(scanModuleEdges('import { MAX_SEEN_POS_SEC } from "./app.ts"')).toEqual([
      { specifier: "./app.ts", kind: "value" },
    ]);
  });

  it("中括弧の中の type は値 import 扱いにする", () => {
    expect(scanModuleEdges('import { type LatLon, destinationPoint } from "../shared/geo.ts";')).toEqual([
      { specifier: "../shared/geo.ts", kind: "value" },
    ]);
    expect(scanModuleEdges('import { type LatLon } from "../shared/geo.ts";')).toEqual([
      { specifier: "../shared/geo.ts", kind: "value" },
    ]);
  });

  it("名前空間 import・既定 import・副作用だけの import を拾う", () => {
    expect(scanModuleEdges('import * as path from "node:path";')).toEqual([
      { specifier: "node:path", kind: "value" },
    ]);
    expect(scanModuleEdges('import React, { useState } from "react";')).toEqual([
      { specifier: "react", kind: "value" },
    ]);
    expect(scanModuleEdges('import "./styles.css";')).toEqual([{ specifier: "./styles.css", kind: "value" }]);
  });

  it("再エクスポートも辺として拾う（バリア越しの抜け道を塞ぐ）", () => {
    expect(scanModuleEdges('export { createApp } from "./app.ts";')).toEqual([
      { specifier: "./app.ts", kind: "value" },
    ]);
    expect(scanModuleEdges('export * from "./app.ts";')).toEqual([{ specifier: "./app.ts", kind: "value" }]);
    expect(scanModuleEdges('export type { AppTracks } from "./app.ts";')).toEqual([
      { specifier: "./app.ts", kind: "type" },
    ]);
  });

  it("複数行の import を 1 件として読む", () => {
    const source = [
      "import {",
      "  aggregateAirportOps,",
      "  AIRPORT_OPS_WINDOW_MS,",
      '} from "./estimate/airportOps.ts";',
    ].join("\n");
    expect(scanModuleEdges(source)).toEqual([{ specifier: "./estimate/airportOps.ts", kind: "value" }]);
  });

  it("コメントの中や字下げされた import は拾わない", () => {
    const source = [
      '// import { attachRoutes } from "./app.ts";',
      "/**",
      ' * import { createApp } from "./app.ts";',
      " */",
      "/* eslint-disable */",
      '  import { createApp } from "./app.ts";',
      'import type { AppTracks } from "./app.ts";',
    ].join("\n");
    expect(scanModuleEdges(source)).toEqual([{ specifier: "./app.ts", kind: "type" }]);
  });

  it("from を持たない宣言や本文は辺にしない（型宣言の中括弧に引きずられない）", () => {
    const source = [
      "export { MAX_SEEN_POS_SEC };",
      "export type ComposeAppOptions = {",
      "  /** 上流から取る fetch */",
      "  fetch?: FetchLike;",
      "};",
      "export function createApp() {",
      '  return { from: "./app.ts" };',
      "}",
      'import { aggregateAirportOps } from "./estimate/airportOps.ts";',
    ].join("\n");
    expect(scanModuleEdges(source)).toEqual([{ specifier: "./estimate/airportOps.ts", kind: "value" }]);
  });

  it("読み切れない import は黙らず投げる", () => {
    expect(() => scanModuleEdges('import {\n  attachRoutes,')).toThrow(/読み切れません/);
  });
});
