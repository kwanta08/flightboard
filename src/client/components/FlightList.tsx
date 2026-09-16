// 周辺の機体の一覧（AC-B4・AC-B6〜B8）。値と文言は lib/flightRows.ts、表示の判断は lib/listView.ts、
// キー操作の判断は lib/listNavigation.ts が決め、ここは描画とクリック・キー操作の受け渡しだけを行う。
import { useEffect, type KeyboardEvent, type Ref } from "react";
import { ESTIMATE_BADGE_LABEL_PREFIX } from "../lib/estimateView.ts";
import type { FlightRow } from "../lib/flightRows.ts";
import { listKeyAction } from "../lib/listNavigation.ts";
import {
  activeDescendantId,
  FLIGHT_LIST_LABEL,
  flightRowId,
  isRowSelected,
  rowClassNames,
  rowElevationText,
  widenRadiusLabel,
  type ListBody,
} from "../lib/listView.ts";

type FlightListProps = {
  /** 並べ替え済みの行（listRows） */
  rows: readonly FlightRow[];
  /** 一覧の本体に出すもの（listBody） */
  body: ListBody;
  selectedHex?: string;
  onSelect(hex: string): void;
  /** Esc（詳細を閉じる＝選択を解除する） */
  onEscape(): void;
  /** 「半径を広げる」で次の段の半径に変える */
  onWidenRadius(radiusKm: number): void;
  /** 一覧（listbox）。行があるときだけ描画する。「半径を広げる」の後に行が出たら App がここへフォーカスを移す */
  listRef?: Ref<HTMLUListElement>;
  /** 「半径を広げる」ボタン。広げた後も 0 件で次の段があれば App がここへフォーカスを移す */
  widenButtonRef?: Ref<HTMLButtonElement>;
};

/** 0 件の案内と「半径を広げる」ボタン */
function EmptyNotice({
  message,
  widenTo,
  buttonRef,
  onWidenRadius,
}: {
  message: string;
  widenTo?: number;
  buttonRef?: Ref<HTMLButtonElement>;
  onWidenRadius(radiusKm: number): void;
}) {
  return (
    <div className="flight-list-empty">
      <p className="flight-list-empty-message">{message}</p>
      {widenTo !== undefined ? (
        <button type="button" className="flight-list-widen" ref={buttonRef} onClick={() => onWidenRadius(widenTo)}>
          {widenRadiusLabel(widenTo)}
        </button>
      ) : null}
    </div>
  );
}

/** 1 行の中身（S-02 の並び） */
function FlightRowContent({ row }: { row: FlightRow }) {
  return (
    <>
      <div className="flight-row-line flight-row-head">
        <span className="flight-callsign">{row.callsignText}</span>{" "}
        <span className="flight-airline">{row.airlineText}</span>{" "}
        {row.badgeText !== undefined ? (
          <>
            <span className="flight-badge">{row.badgeText}</span>{" "}
          </>
        ) : null}
        <span className="flight-distance">{row.distanceText}</span>
      </div>
      {row.routeText !== undefined ? <div className="flight-row-line flight-route">{row.routeText}</div> : null}
      <div className="flight-row-line flight-row-status">
        <span className="flight-type">{row.typeText}</span>{" "}
        <span className="flight-altitude">{row.altitudeText}</span>{" "}
        <span className="flight-speed">{row.speedText}</span>
        {row.trendText !== undefined ? (
          <>
            {" "}
            <span className="flight-trend">{row.trendText}</span>
          </>
        ) : null}
      </div>
      <div className="flight-row-line flight-row-sky">
        <span className="flight-bearing">{row.bearingText}</span>{" "}
        <span className="flight-elevation">{rowElevationText(row)}</span>
        {row.visibilityLabel !== undefined ? (
          <>
            {" "}
            <span className="flight-visibility">{row.visibilityLabel}</span>
          </>
        ) : null}
      </div>
      {/* 経路の推定バッジ（AC-P2-50・AC-P2-51）。推定の無い機体では行ごと出さない。
          ボタン・リンクにしないので Tab の停止点は増えない。
          「推定」は不可視の文字として text の前に置く（素の span は WAI-ARIA 1.2 の generic ロールで
          名前付けが禁止されているので aria-label は使わない。読み上げは estimateBadge.label と同じになる） */}
      {row.estimateBadge !== undefined ? (
        <div className="flight-row-line flight-row-estimate">
          <span className={row.estimateBadge.className}>
            <span className="visually-hidden">{ESTIMATE_BADGE_LABEL_PREFIX} </span>
            {row.estimateBadge.text}
          </span>
        </div>
      ) : null}
    </>
  );
}

export function FlightList({
  rows,
  body,
  selectedHex,
  onSelect,
  onEscape,
  onWidenRadius,
  listRef,
  widenButtonRef,
}: FlightListProps) {
  const activeId = activeDescendantId(rows, selectedHex);

  // 選択が変わったら該当行を見える位置までスクロールする（地図のアイコンで選んだときも）
  useEffect(() => {
    if (activeId !== undefined) {
      document.getElementById(activeId)?.scrollIntoView({ block: "nearest" });
    }
  }, [activeId]);

  const handleKeyDown = (event: KeyboardEvent<HTMLUListElement>) => {
    const action = listKeyAction(
      rows.map((row) => row.hex),
      selectedHex,
      event.key,
    );
    if (action === undefined) return;
    event.preventDefault();
    if (action.kind === "select") onSelect(action.hex);
    if (action.kind === "escape") onEscape();
  };

  return (
    <div className="flight-list-scroll">
      {body.kind === "empty" ? (
        <EmptyNotice
          message={body.message}
          widenTo={body.widenTo}
          buttonRef={widenButtonRef}
          onWidenRadius={onWidenRadius}
        />
      ) : null}
      {/* 行が無いとき（取得中・失敗・0 件）は空の listbox をアクセシビリティツリーに残さない */}
      {body.kind === "rows" ? (
        <ul
          className="flight-list"
          ref={listRef}
          role="listbox"
          aria-label={FLIGHT_LIST_LABEL}
          aria-activedescendant={activeId}
          tabIndex={0}
          onKeyDown={handleKeyDown}
        >
          {rows.map((row) => (
            <li
              key={row.hex}
              id={flightRowId(row.hex)}
              role="option"
              aria-selected={isRowSelected(row.hex, selectedHex)}
              className={rowClassNames(row, isRowSelected(row.hex, selectedHex))}
              onClick={() => onSelect(row.hex)}
            >
              <FlightRowContent row={row} />
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
