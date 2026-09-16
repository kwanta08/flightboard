import { afterEach, describe, expect, it, vi } from "vitest";
import { USER_AGENT } from "../providers/provider.ts";
import type { FetchLike } from "../providers/provider.ts";
import { createPhotoSource, parsePhoto } from "./planespotters.ts";

/** 実際の応答（api.planespotters.net/pub/photos/hex/861f5e）と同じ形 */
const PHOTO_BODY = {
  photos: [
    {
      id: "1974079",
      thumbnail: { src: "https://t.plnspttrs.net/00142/1974079_t.jpg", size: { width: 200, height: 112 } },
      thumbnail_large: { src: "https://t.plnspttrs.net/00142/1974079_280.jpg", size: { width: 498, height: 280 } },
      link: "https://www.planespotters.net/photo/1974079/ja618a-all-nippon-airways-boeing-767",
      photographer: "Demo Borstell",
    },
  ],
};

const EXPECTED = {
  url: "https://t.plnspttrs.net/00142/1974079_280.jpg",
  thumbnailUrl: "https://t.plnspttrs.net/00142/1974079_t.jpg",
  credit: "Demo Borstell",
  link: "https://www.planespotters.net/photo/1974079/ja618a-all-nippon-airways-boeing-767",
};

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}

function errorResponse(status: number, headers: Record<string, string> = {}): Response {
  return new Response("", { status, headers });
}

function headerOf(init: RequestInit, name: string): string | undefined {
  return (init.headers as Record<string, string> | undefined)?.[name];
}

function setup(respond: (url: string) => Response | Promise<Response>) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchImpl: FetchLike = (url, init) => {
    calls.push({ url, init });
    return Promise.resolve(respond(url));
  };
  let clock = 1_000_000;
  const source = createPhotoSource({ fetch: fetchImpl, now: () => clock, ttlMs: 10_000, errorTtlMs: 1000 });
  return { calls, source, advance: (ms: number) => (clock += ms) };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("parsePhoto", () => {
  it("thumbnail_large を表示用、thumbnail を控えに、撮影者名とリンクを取る", () => {
    expect(parsePhoto(PHOTO_BODY)).toStrictEqual(EXPECTED);
  });

  it("thumbnail_large が無ければ thumbnail を表示用にし、thumbnailUrl は付けない", () => {
    const body = { photos: [{ ...PHOTO_BODY.photos[0], thumbnail_large: undefined }] };
    expect(parsePhoto(body)).toStrictEqual({
      url: "https://t.plnspttrs.net/00142/1974079_t.jpg",
      credit: "Demo Borstell",
      link: EXPECTED.link,
    });
  });

  it.each([
    ["写真が無い", { photos: [] }],
    ["photos が配列でない", { photos: null }],
    ["応答が JSON のオブジェクトでない", "photos"],
  ])("%s → undefined", (_label, body) => {
    expect(parsePhoto(body)).toBeUndefined();
  });

  it("撮影者名・リンクの欠けた写真は飛ばし、揃っている次の写真を使う（仕様 §13）", () => {
    const body = {
      photos: [
        { ...PHOTO_BODY.photos[0], photographer: "  " },
        { ...PHOTO_BODY.photos[0], link: null },
        PHOTO_BODY.photos[0],
      ],
    };
    expect(parsePhoto(body)).toStrictEqual(EXPECTED);
  });

  it("http(s) 以外の画像 URL・リンクは採用しない", () => {
    const badImage = { photos: [{ ...PHOTO_BODY.photos[0], thumbnail_large: { src: "javascript:alert(1)" }, thumbnail: { src: "not a url" } }] };
    const badLink = { photos: [{ ...PHOTO_BODY.photos[0], link: "javascript:alert(1)" }] };
    expect(parsePhoto(badImage)).toBeUndefined();
    expect(parsePhoto(badLink)).toBeUndefined();
  });
});

describe("getPhoto", () => {
  it("/pub/photos/hex/{hex} に連絡先入りの User-Agent で要求する", async () => {
    const s = setup(() => jsonResponse(PHOTO_BODY));
    await expect(s.source.getPhoto("861f5e")).resolves.toStrictEqual(EXPECTED);
    expect(s.calls).toHaveLength(1);
    expect(s.calls[0]?.url).toBe("https://api.planespotters.net/pub/photos/hex/861f5e");
    expect(headerOf(s.calls[0]!.init, "User-Agent")).toBe(USER_AGENT);
    expect(USER_AGENT).toMatch(/\+https:\/\/|@/); // 規約: 連絡先の URL かメールを含める
  });

  it("ICAO アドレスでない hex（先頭が ~）は照会しない", async () => {
    const s = setup(() => jsonResponse(PHOTO_BODY));
    await expect(s.source.getPhoto("~abc123")).resolves.toBeUndefined();
    expect(s.calls).toEqual([]);
  });

  it("2 回目は保持した結果を返す（期限が切れたら照会し直す）", async () => {
    const s = setup(() => jsonResponse(PHOTO_BODY));
    await s.source.getPhoto("861f5e");
    await expect(s.source.getPhoto("861f5e")).resolves.toStrictEqual(EXPECTED);
    expect(s.calls).toHaveLength(1);

    s.advance(10_001);
    await s.source.getPhoto("861f5e");
    expect(s.calls).toHaveLength(2);
  });

  it("同じ hex の同時呼び出しは 1 回の照会を共有する", async () => {
    const s = setup(() => jsonResponse(PHOTO_BODY));
    const [a, b] = await Promise.all([s.source.getPhoto("861f5e"), s.source.getPhoto("861f5e")]);
    expect(a).toStrictEqual(EXPECTED);
    expect(b).toStrictEqual(EXPECTED);
    expect(s.calls).toHaveLength(1);
  });

  it("写真が見つからない応答は undefined を保持する（再照会しない）", async () => {
    const s = setup(() => jsonResponse({ photos: [] }));
    await expect(s.source.getPhoto("861f5e")).resolves.toBeUndefined();
    await s.source.getPhoto("861f5e");
    expect(s.calls).toHaveLength(1);
  });

  it("通信失敗は undefined を返し、短い期限で保持する（例外にしない）", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const s = setup(() => errorResponse(500));
    await expect(s.source.getPhoto("861f5e")).resolves.toBeUndefined();
    await s.source.getPhoto("861f5e");
    expect(s.calls).toHaveLength(1);

    s.advance(1001);
    await s.source.getPhoto("861f5e");
    expect(s.calls).toHaveLength(2);
  });

  it("HTTP 429 の後は Retry-After が過ぎるまで照会しない", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    let body: Response = errorResponse(429, { "Retry-After": "30" });
    const s = setup(() => body);

    await expect(s.source.getPhoto("861f5e")).resolves.toBeUndefined();
    expect(s.calls).toHaveLength(1);

    body = jsonResponse(PHOTO_BODY);
    s.advance(29_000);
    await expect(s.source.getPhoto("869236")).resolves.toBeUndefined();
    expect(s.calls).toHaveLength(1); // 制限中は送らない

    s.advance(2000);
    await expect(s.source.getPhoto("869236")).resolves.toStrictEqual(EXPECTED);
    expect(s.calls).toHaveLength(2);
  });
});
