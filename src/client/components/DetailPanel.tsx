// 機体の詳細パネル（AC-B12・AC-B8・AC-B13）。地図ペインの右側に重ねて出す（フォーカスは奪わない）。
// 表示の判断と文言は lib/detailView.ts・lib/detailState.ts が決め、ここは描画と閉じる操作の受け渡しだけを行う。
import { useId, useMemo, type KeyboardEvent } from "react";
import type { AirportOps } from "../../shared/types.ts";
import type { DetailState } from "../lib/detailState.ts";
import {
  DETAIL_CLOSE_LABEL,
  DETAIL_CLOSE_TEXT,
  DETAIL_PANEL_LABEL,
  detailPanelContent,
  isCloseKey,
  ROUTE_PROGRESS_LABEL,
  type DetailNotes,
  type DetailRoute,
  type DetailView,
} from "../lib/detailView.ts";
import type { Observer } from "../lib/flightRows.ts";

type DetailPanelProps = {
  /** 選択中の機体の詳細の取得状態（useFlightDetail） */
  state: DetailState;
  /** 観測地点（自分との関係の計算に使う） */
  observer: Observer;
  /** 空港の運用方向の集計（`/api/nearby` の `airportOps`）。「経路」の区分の「運用方向」に使う */
  airportOps?: readonly AirportOps[];
  /** 閉じるボタンとパネル内の Esc（詳細を閉じる＝選択を解除する） */
  onClose(): void;
};

/** 出発地 → 到着地、進み具合、注記 */
function RouteBlock({ route }: { route: DetailRoute }) {
  return (
    <div className="detail-route">
      <p className="detail-route-airports">
        <span className="detail-route-airport">{route.originLabel}</span>
        <span className="detail-route-arrow"> → </span>
        <span className="detail-route-airport">{route.destinationLabel}</span>
      </p>
      {route.progress !== undefined ? (
        <div className="detail-route-progress">
          <progress className="detail-progress" max={1} value={route.progress} aria-label={ROUTE_PROGRESS_LABEL}>
            {route.progressText}
          </progress>
          <span className="detail-progress-text">{route.progressText}</span>
        </div>
      ) : null}
      <p className="detail-note">{route.note}</p>
    </div>
  );
}

/**
 * 区分に添える補足の一覧（「経路」の区分の根拠。S-03）。
 * 何の一覧かが目視でも読み上げでも分かるように見出し（「根拠」）を描き、その見出しで一覧に名前を付ける
 * （list ロールは名前付けできる）。同じ文が並びうるので位置で key を付ける（並べ替えも編集もしない一覧）
 */
function SectionNotes({ notes }: { notes: DetailNotes }) {
  const labelId = useId();
  return (
    <>
      <h4 className="detail-notes-label" id={labelId}>
        {notes.label}
      </h4>
      <ul className="detail-notes" aria-labelledby={labelId}>
        {notes.lines.map((line, index) => (
          <li key={index} className="detail-note-item">
            {line}
          </li>
        ))}
      </ul>
    </>
  );
}

/** 写真・ルート・各区分 */
function DetailViewBody({ view }: { view: DetailView }) {
  return (
    <>
      {view.photo !== undefined ? (
        <figure className="detail-photo">
          <img
            className="detail-photo-image"
            src={view.photo.src}
            alt={view.photo.alt}
            loading="lazy"
            referrerPolicy="no-referrer"
          />
          <figcaption className="detail-photo-credit">
            {/* 提供元の規約で、クレジットから写真ページへリンクする */}
            <a href={view.photo.link} target="_blank" rel="noreferrer">
              {view.photo.credit}
            </a>
          </figcaption>
        </figure>
      ) : null}
      {view.route !== undefined ? <RouteBlock route={view.route} /> : null}
      {view.sections.map((section) => (
        <section key={section.title} className="detail-section">
          <h3 className="detail-section-title">{section.title}</h3>
          <dl className="detail-list">
            {section.items.map((item) => (
              <div key={item.label} className="detail-item">
                <dt className="detail-item-label">{item.label}</dt>
                <dd className="detail-item-value">{item.value}</dd>
              </div>
            ))}
          </dl>
          {/* 根拠は「経路」の区分だけが持つ（無い区分では描かない） */}
          {section.notes !== undefined && section.notes.lines.length > 0 ? <SectionNotes notes={section.notes} /> : null}
        </section>
      ))}
    </>
  );
}

export function DetailPanel({ state, observer, airportOps, onClose }: DetailPanelProps) {
  const content = useMemo(() => detailPanelContent(state, observer, airportOps), [state, observer, airportOps]);

  const handleKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (!isCloseKey(event.key)) return;
    event.preventDefault();
    onClose();
  };

  return (
    <aside className="detail-panel" aria-label={DETAIL_PANEL_LABEL} onKeyDown={handleKeyDown}>
      <header className="detail-header">
        <div className="detail-heading">
          <h2 className="detail-title">{content.title}</h2>
          {content.subtitle !== undefined ? <p className="detail-subtitle">{content.subtitle}</p> : null}
        </div>
        <button type="button" className="detail-close" aria-label={DETAIL_CLOSE_LABEL} onClick={onClose}>
          {DETAIL_CLOSE_TEXT}
        </button>
      </header>
      <div className="detail-body">
        {content.message !== undefined ? <p className="detail-message">{content.message}</p> : null}
        {content.notice !== undefined ? <p className="detail-notice">{content.notice}</p> : null}
        {content.view !== undefined ? <DetailViewBody view={content.view} /> : null}
      </div>
    </aside>
  );
}
