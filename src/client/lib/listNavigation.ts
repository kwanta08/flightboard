// 一覧のキーボード操作（AC-B8・§5）。FlightList.tsx はこの結果で選択を変えるだけにする。

/** 選択を動かすキー */
export type MoveKey = "ArrowUp" | "ArrowDown" | "Home" | "End";

/** 一覧の操作に使うキー（Escape は詳細を閉じる＝選択を解除する） */
export type NavigationKey = MoveKey | "Escape";

const NAVIGATION_KEYS: ReadonlyArray<NavigationKey> = ["ArrowUp", "ArrowDown", "Home", "End", "Escape"];

/** `KeyboardEvent.key` を一覧の操作のキーとして解釈する。操作に使わないキーなら undefined */
export function navigationKey(key: string): NavigationKey | undefined {
  return NAVIGATION_KEYS.find((candidate) => candidate === key);
}

/** 移動先の添字。`index` は現在の選択の添字（未選択・一覧に無ければ -1）、`last` は末尾の添字 */
function targetIndex(index: number, last: number, key: MoveKey): number {
  switch (key) {
    case "Home":
      return 0;
    case "End":
      return last;
    case "ArrowDown":
      // 未選択からは先頭。末尾では止まる（折り返さない）
      return index < 0 ? 0 : Math.min(index + 1, last);
    case "ArrowUp":
      // 未選択からは末尾。先頭では止まる（折り返さない）
      return index < 0 ? last : Math.max(index - 1, 0);
  }
}

/**
 * キーを押した後に選択する機体の hex。一覧が空なら undefined。
 * 未選択（または `current` が一覧に無い）なら ↓ で先頭・↑ で末尾、選択中なら ↓ で次・↑ で前（端では止まる）、
 * Home で先頭・End で末尾
 */
export function nextSelection(hexes: readonly string[], current: string | undefined, key: MoveKey): string | undefined {
  if (hexes.length === 0) {
    return undefined;
  }
  const index = current === undefined ? -1 : hexes.indexOf(current);
  return hexes[targetIndex(index, hexes.length - 1, key)];
}

/**
 * 一覧でキーを押したときの動作。
 * select: `hex` を選択する / escape: 詳細を閉じる（選択を解除する） / none: 操作のキーだが何もしない（一覧が空）。
 * 操作のキーは既定の動作（スクロール）を止める
 */
export type ListKeyAction = { kind: "select"; hex: string } | { kind: "escape" } | { kind: "none" };

/** 一覧でキーを押したときの動作。操作に使わないキーなら undefined（ブラウザの既定の動作に任せる） */
export function listKeyAction(
  hexes: readonly string[],
  current: string | undefined,
  key: string,
): ListKeyAction | undefined {
  const navigation = navigationKey(key);
  if (navigation === undefined) {
    return undefined;
  }
  if (navigation === "Escape") {
    return { kind: "escape" };
  }
  const hex = nextSelection(hexes, current, navigation);
  return hex === undefined ? { kind: "none" } : { kind: "select", hex };
}
