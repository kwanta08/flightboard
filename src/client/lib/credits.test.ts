import { describe, expect, it } from "vitest";
import { CREDITS, DISCLAIMER, OSM_ATTRIBUTION, OSM_TILE_URL } from "./credits.ts";

describe("CREDITS", () => {
  // AC-B3 の 6 つの提供元と、Phase 2 で滑走路データに使う OurAirports（AC-P2-06）。
  // 各クレジットの文言に含まれるべき文字列
  it.each([
    ["adsb.lol", ["adsb.lol", "ODbL 1.0"]],
    ["adsb.fi", ["adsb.fi"]],
    ["OpenSky Network", ["OpenSky Network"]],
    ["adsbdb", ["adsbdb"]],
    ["OurAirports（滑走路データ）", ["OurAirports", "パブリックドメイン"]],
    ["Planespotters.net（写真）", ["写真", "Planespotters.net"]],
    ["OpenStreetMap", ["© OpenStreetMap contributors"]],
  ] as const)("%s のクレジットがある", (_name, fragments) => {
    expect(CREDITS.some((credit) => fragments.every((fragment) => credit.label.includes(fragment)))).toBe(true);
  });

  it("adsb.fi はホームページ https://adsb.fi へリンクする", () => {
    const adsbfi = CREDITS.find((credit) => credit.label.includes("adsb.fi"));
    expect(adsbfi?.href).toBe("https://adsb.fi");
  });

  it("OurAirports は https://ourairports.com へリンクする（仕様 §13）", () => {
    expect(CREDITS.find((credit) => credit.id === "ourairports")?.href).toBe("https://ourairports.com");
  });

  it("id は重複せず、リンク先はすべて https", () => {
    expect(new Set(CREDITS.map((credit) => credit.id)).size).toBe(CREDITS.length);
    for (const credit of CREDITS) {
      expect(credit.href).toMatch(/^https:\/\//);
    }
  });
});

describe("OSM_TILE_URL", () => {
  it("OpenStreetMap の標準タイル", () => {
    expect(OSM_TILE_URL).toBe("https://tile.openstreetmap.org/{z}/{x}/{y}.png");
  });
});

describe("OSM_ATTRIBUTION", () => {
  it("© と、著作権ページへリンクした OpenStreetMap contributors", () => {
    expect(OSM_ATTRIBUTION).toBe(
      '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    );
  });

  it("リンク先はフッターの OpenStreetMap のクレジットと同じ著作権ページ", () => {
    const hrefs = [...OSM_ATTRIBUTION.matchAll(/href="([^"]*)"/g)].map((match) => match[1]);
    expect(hrefs).toEqual(["https://www.openstreetmap.org/copyright"]);
    expect(CREDITS.find((credit) => credit.id === "osm")?.href).toBe(hrefs[0]);
  });
});

describe("DISCLAIMER", () => {
  it("仕様 §13 の免責文と一字一句同じ", () => {
    expect(DISCLAIMER).toBe("経路の表示は推定です。航行や安全の判断には使わないでください");
  });
});
