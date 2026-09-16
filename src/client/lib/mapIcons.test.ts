import { describe, expect, it } from "vitest";
import {
  AIRCRAFT_ICON_HEADING_CLASS,
  AIRCRAFT_ICON_NO_HEADING_CLASS,
  AIRCRAFT_ICON_SELECTED_CLASS,
  aircraftIcon,
  observerIcon,
} from "./mapIcons.ts";

function classes(className: string): string[] {
  return className.split(/\s+/);
}

describe("aircraftIcon（AC-B10）", () => {
  describe("回転", () => {
    it("trackDeg 123.4 → 123° で回転する機体の形", () => {
      const icon = aircraftIcon({ trackDeg: 123.4, selected: false, kind: "passenger" });
      expect(icon.html).toContain("rotate(123deg)");
      expect(icon.html).toContain("<svg");
      expect(classes(icon.className)).toContain(AIRCRAFT_ICON_HEADING_CLASS);
    });

    it("123.5 は 124° に丸める", () => {
      expect(aircraftIcon({ trackDeg: 123.5, selected: false, kind: "passenger" }).html).toContain("rotate(124deg)");
    });

    it("trackDeg 0（真北）も回転する形（0° を「無い」と扱わない）", () => {
      const icon = aircraftIcon({ trackDeg: 0, selected: false, kind: "passenger" });
      expect(icon.html).toContain("rotate(0deg)");
      expect(classes(icon.className)).toContain(AIRCRAFT_ICON_HEADING_CLASS);
    });

    it("359.6 は 360 ではなく 0°", () => {
      expect(aircraftIcon({ trackDeg: 359.6, selected: false, kind: "passenger" }).html).toContain("rotate(0deg)");
    });
  });

  describe("trackDeg 無し", () => {
    it.each([undefined, Number.NaN])("trackDeg = %s → 回転しない別の形（丸）", (trackDeg) => {
      const icon = aircraftIcon({ trackDeg, selected: false, kind: "passenger" });
      expect(icon.html).not.toContain("rotate");
      expect(icon.html).not.toContain("<svg");
      expect(icon.html).toContain("aircraft-icon-dot");
      expect(classes(icon.className)).toContain(AIRCRAFT_ICON_NO_HEADING_CLASS);
      expect(classes(icon.className)).not.toContain(AIRCRAFT_ICON_HEADING_CLASS);
    });
  });

  describe("選択", () => {
    it("選択中は大きくなり、枠線のクラスが付く（色だけに頼らない）", () => {
      const normal = aircraftIcon({ trackDeg: 90, selected: false, kind: "passenger" });
      const selected = aircraftIcon({ trackDeg: 90, selected: true, kind: "passenger" });
      expect(selected.size[0]).toBeGreaterThan(normal.size[0]);
      expect(selected.size[1]).toBeGreaterThan(normal.size[1]);
      expect(classes(selected.className)).toContain(AIRCRAFT_ICON_SELECTED_CLASS);
      expect(classes(normal.className)).not.toContain(AIRCRAFT_ICON_SELECTED_CLASS);
    });

    it("回転しない形でも選択中は大きく枠線のクラスが付く", () => {
      const normal = aircraftIcon({ selected: false, kind: "passenger" });
      const selected = aircraftIcon({ selected: true, kind: "passenger" });
      expect(selected.size[0]).toBeGreaterThan(normal.size[0]);
      expect(classes(selected.className)).toContain(AIRCRAFT_ICON_SELECTED_CLASS);
    });

    it("アンカーはアイコンの中心", () => {
      for (const selected of [false, true]) {
        const icon = aircraftIcon({ trackDeg: 10, selected, kind: "passenger" });
        expect(icon.anchor).toEqual([icon.size[0] / 2, icon.size[1] / 2]);
      }
    });
  });

  describe("貨物", () => {
    it("貨物はクラスで区別する", () => {
      expect(classes(aircraftIcon({ trackDeg: 90, selected: false, kind: "cargo" }).className)).toContain("aircraft-icon--cargo");
      expect(classes(aircraftIcon({ trackDeg: 90, selected: false, kind: "passenger" }).className)).not.toContain(
        "aircraft-icon--cargo",
      );
    });
  });

  describe("key", () => {
    it("同じ入力なら同じ key（丸めて同じ角度も同じ key）", () => {
      const a = aircraftIcon({ trackDeg: 123.4, selected: false, kind: "passenger" });
      expect(aircraftIcon({ trackDeg: 123.4, selected: false, kind: "passenger" }).key).toBe(a.key);
      expect(aircraftIcon({ trackDeg: 122.6, selected: false, kind: "passenger" }).key).toBe(a.key);
    });

    it("違う角度・選択・種類・形なら違う key", () => {
      const base = aircraftIcon({ trackDeg: 123, selected: false, kind: "passenger" });
      const others = [
        aircraftIcon({ trackDeg: 124, selected: false, kind: "passenger" }),
        aircraftIcon({ trackDeg: 123, selected: true, kind: "passenger" }),
        aircraftIcon({ trackDeg: 123, selected: false, kind: "cargo" }),
        aircraftIcon({ selected: false, kind: "passenger" }),
      ];
      for (const other of others) {
        expect(other.key).not.toBe(base.key);
      }
    });

    it("同じ key なら html・className・大きさも同じ", () => {
      const a = aircraftIcon({ trackDeg: 45.2, selected: true, kind: "cargo" });
      const b = aircraftIcon({ trackDeg: 44.8, selected: true, kind: "cargo" });
      expect(b.key).toBe(a.key);
      expect(b).toEqual(a);
    });
  });
});

describe("observerIcon", () => {
  it("観測地点の印（回転せず、中心がアンカー）", () => {
    const icon = observerIcon();
    expect(icon.key).toBe("observer");
    expect(icon.className).toContain("observer-icon");
    expect(icon.html).not.toContain("rotate");
    expect(icon.anchor).toEqual([icon.size[0] / 2, icon.size[1] / 2]);
  });

  it("機体のアイコンと key が重ならない", () => {
    expect(observerIcon().key).not.toBe(aircraftIcon({ selected: false, kind: "passenger" }).key);
  });
});
