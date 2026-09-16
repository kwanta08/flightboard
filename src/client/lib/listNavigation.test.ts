import { describe, expect, it } from "vitest";
import { listKeyAction, type MoveKey, navigationKey, nextSelection } from "./listNavigation.ts";

const HEXES: readonly string[] = ["aaa111", "bbb222", "ccc333"];
const MOVE_KEYS: readonly MoveKey[] = ["ArrowUp", "ArrowDown", "Home", "End"];

describe("nextSelection（AC-B8）", () => {
  describe("空の一覧", () => {
    it.each(MOVE_KEYS)("未選択で %s → undefined", (key) => {
      expect(nextSelection([], undefined, key)).toBeUndefined();
    });

    it.each(MOVE_KEYS)("選択が残っていても %s → undefined", (key) => {
      expect(nextSelection([], "aaa111", key)).toBeUndefined();
    });
  });

  describe("未選択から", () => {
    it("↓ で先頭", () => {
      expect(nextSelection(HEXES, undefined, "ArrowDown")).toBe("aaa111");
    });

    it("↑ で末尾", () => {
      expect(nextSelection(HEXES, undefined, "ArrowUp")).toBe("ccc333");
    });

    it("Home で先頭・End で末尾", () => {
      expect(nextSelection(HEXES, undefined, "Home")).toBe("aaa111");
      expect(nextSelection(HEXES, undefined, "End")).toBe("ccc333");
    });
  });

  describe("選択中から", () => {
    it("↓ で次", () => {
      expect(nextSelection(HEXES, "aaa111", "ArrowDown")).toBe("bbb222");
      expect(nextSelection(HEXES, "bbb222", "ArrowDown")).toBe("ccc333");
    });

    it("↑ で前", () => {
      expect(nextSelection(HEXES, "ccc333", "ArrowUp")).toBe("bbb222");
      expect(nextSelection(HEXES, "bbb222", "ArrowUp")).toBe("aaa111");
    });

    it("先頭で ↑ は先頭のまま（折り返さない）", () => {
      expect(nextSelection(HEXES, "aaa111", "ArrowUp")).toBe("aaa111");
    });

    it("末尾で ↓ は末尾のまま（折り返さない）", () => {
      expect(nextSelection(HEXES, "ccc333", "ArrowDown")).toBe("ccc333");
    });

    it("中ほどから Home で先頭・End で末尾", () => {
      expect(nextSelection(HEXES, "bbb222", "Home")).toBe("aaa111");
      expect(nextSelection(HEXES, "bbb222", "End")).toBe("ccc333");
    });

    it("1 件だけの一覧ではどのキーでもその 1 件のまま", () => {
      for (const key of MOVE_KEYS) {
        expect(nextSelection(["only"], "only", key)).toBe("only");
      }
    });
  });

  describe("選択中の機体が一覧から消えた（current が一覧に無い）", () => {
    it("↓ で先頭", () => {
      expect(nextSelection(HEXES, "gone00", "ArrowDown")).toBe("aaa111");
    });

    it("↑ で末尾", () => {
      expect(nextSelection(HEXES, "gone00", "ArrowUp")).toBe("ccc333");
    });

    it("Home で先頭・End で末尾", () => {
      expect(nextSelection(HEXES, "gone00", "Home")).toBe("aaa111");
      expect(nextSelection(HEXES, "gone00", "End")).toBe("ccc333");
    });
  });

  it("入力の配列を変えない", () => {
    const hexes = ["aaa111", "bbb222"];
    nextSelection(hexes, "aaa111", "ArrowDown");
    expect(hexes).toEqual(["aaa111", "bbb222"]);
  });
});

describe("navigationKey（KeyboardEvent.key の解釈）", () => {
  it.each(["ArrowUp", "ArrowDown", "Home", "End", "Escape"])("%s → %s", (key) => {
    expect(navigationKey(key)).toBe(key);
  });

  it.each(["Enter", " ", "Tab", "a", "PageDown", "ArrowLeft", "arrowdown", ""])("%j → undefined", (key) => {
    expect(navigationKey(key)).toBeUndefined();
  });
});

describe("listKeyAction（キーを押したときの動作）", () => {
  it("操作に使わないキーは undefined（既定の動作を止めない）", () => {
    expect(listKeyAction(HEXES, "aaa111", "Enter")).toBeUndefined();
    expect(listKeyAction(HEXES, undefined, "Tab")).toBeUndefined();
  });

  it("Escape は選択の有無にかかわらず escape", () => {
    expect(listKeyAction(HEXES, "bbb222", "Escape")).toEqual({ kind: "escape" });
    expect(listKeyAction(HEXES, undefined, "Escape")).toEqual({ kind: "escape" });
    expect(listKeyAction([], undefined, "Escape")).toEqual({ kind: "escape" });
  });

  it("移動のキーは nextSelection の結果を選択する", () => {
    expect(listKeyAction(HEXES, undefined, "ArrowDown")).toEqual({ kind: "select", hex: "aaa111" });
    expect(listKeyAction(HEXES, "aaa111", "ArrowDown")).toEqual({ kind: "select", hex: "bbb222" });
    expect(listKeyAction(HEXES, "bbb222", "End")).toEqual({ kind: "select", hex: "ccc333" });
    expect(listKeyAction(HEXES, "ccc333", "Home")).toEqual({ kind: "select", hex: "aaa111" });
  });

  it("空の一覧で移動のキーは none（操作のキーなので既定の動作は止める）", () => {
    for (const key of MOVE_KEYS) {
      expect(listKeyAction([], undefined, key)).toEqual({ kind: "none" });
    }
  });
});
