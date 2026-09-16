// 一覧の上のツールバー（AC-B5・AC-B9）。文言と選択肢は lib/listView.ts が決め、ここは描画と値の受け渡しだけを行う。
import type { ChangeEvent, Ref } from "react";
import { useNow } from "../hooks/useNow.ts";
import type { SortMode } from "../lib/flightRows.ts";
import {
  KIND_OPTIONS,
  KIND_SELECT_LABEL,
  kindOptionFromValue,
  RADIUS_OPTIONS,
  RADIUS_SELECT_LABEL,
  radiusFromValue,
  radiusOptionValue,
  SORT_OPTIONS,
  SORT_SELECT_LABEL,
  sortModeFromValue,
  summaryFor,
  type KindOptionValue,
} from "../lib/listView.ts";
import type { PollerState } from "../lib/poller.ts";

type SummaryState = Pick<PollerState, "data" | "error">;

type ListToolbarProps = {
  /** 周辺の機体の取得の状態（件数と更新の文言は summaryFor で作る） */
  state: SummaryState;
  sortMode: SortMode;
  kindOption: KindOptionValue;
  radiusKm: number;
  /** 半径の選択欄（「半径を広げる」でこれ以上広げられないとき App がここへフォーカスを移す） */
  radiusSelectRef?: Ref<HTMLSelectElement>;
  onSortChange(sortMode: SortMode): void;
  onKindChange(kindOption: KindOptionValue): void;
  onRadiusChange(radiusKm: number): void;
};

/**
 * 件数と更新の文言。1 秒ごとに再描画して経過秒を進める（1 秒ごとの再描画をこの段落に閉じ、App や一覧の行を巻き込まない）。
 * 失敗の文言（summaryFor の detail。失敗中だけある）をツールチップ（title）に出す
 */
function ListSummary({ state }: { state: SummaryState }) {
  const now = useNow();
  const summary = summaryFor(state, now);
  return (
    <p className="list-summary" title={summary.detail}>
      {summary.text}
    </p>
  );
}

export function ListToolbar({
  state,
  sortMode,
  kindOption,
  radiusKm,
  radiusSelectRef,
  onSortChange,
  onKindChange,
  onRadiusChange,
}: ListToolbarProps) {
  const handleSortChange = (event: ChangeEvent<HTMLSelectElement>) => {
    const next = sortModeFromValue(event.target.value);
    if (next !== undefined) onSortChange(next);
  };

  const handleKindChange = (event: ChangeEvent<HTMLSelectElement>) => {
    const next = kindOptionFromValue(event.target.value);
    if (next !== undefined) onKindChange(next);
  };

  const handleRadiusChange = (event: ChangeEvent<HTMLSelectElement>) => {
    const next = radiusFromValue(event.target.value);
    if (next !== undefined) onRadiusChange(next);
  };

  return (
    <div className="list-toolbar">
      <ListSummary state={state} />
      <div className="list-controls">
        <label className="list-control">
          <span className="list-control-label">{SORT_SELECT_LABEL}</span>
          <select className="list-select" value={sortMode} onChange={handleSortChange}>
            {SORT_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
        <label className="list-control">
          <span className="list-control-label">{KIND_SELECT_LABEL}</span>
          <select className="list-select" value={kindOption} onChange={handleKindChange}>
            {KIND_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
        <label className="list-control">
          <span className="list-control-label">{RADIUS_SELECT_LABEL}</span>
          <select
            className="list-select"
            ref={radiusSelectRef}
            value={radiusOptionValue(radiusKm)}
            onChange={handleRadiusChange}
          >
            {RADIUS_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
      </div>
    </div>
  );
}
