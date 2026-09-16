// 設定画面（S-04・F-09・AC-P2-71・AC-P2-73）。
// 判断と文言は lib/settingsStore・lib/locationStore・lib/listView に置き、ここは描画と配線だけを行う。
import type { ChangeEvent, Ref } from "react";
import { CREDITS } from "../lib/credits.ts";
import {
  KIND_OPTIONS,
  KIND_SELECT_LABEL,
  kindOptionFromValue,
  RADIUS_OPTIONS,
  RADIUS_SELECT_LABEL,
  radiusFromValue,
  radiusOptionValue,
} from "../lib/listView.ts";
import {
  canRemoveLocation,
  formatLocationOption,
  LOCATION_ADD_LABEL,
  LOCATION_EDIT_LABEL,
  LOCATION_REMOVE_LABEL,
  LOCATION_SECTION_TITLE,
  selectedLocation,
  type LocationBook,
} from "../lib/locationStore.ts";
import {
  ALTITUDE_UNIT_OPTIONS,
  ALTITUDE_UNIT_SELECT_LABEL,
  altitudeUnitFromValue,
  CREDITS_SECTION_TITLE,
  DISPLAY_SECTION_TITLE,
  INTERVAL_OPTIONS,
  INTERVAL_SELECT_LABEL,
  intervalMsFromValue,
  intervalOptionValue,
  SAVE_FAILED_MESSAGE,
  SETTINGS_CLOSE_LABEL,
  SETTINGS_TITLE,
  SPEED_UNIT_OPTIONS,
  SPEED_UNIT_SELECT_LABEL,
  speedUnitFromValue,
  type Settings,
} from "../lib/settingsStore.ts";

type SettingsScreenProps = {
  book: LocationBook;
  settings: Settings;
  /** 地点か設定の保存に失敗しているか（localStorage の容量超過・利用不可） */
  saveFailed: boolean;
  /** 見出し（画面の切り替え時に App がここへフォーカスを移す） */
  headingRef?: Ref<HTMLHeadingElement>;
  onSelectLocation(id: string): void;
  onAddLocation(): void;
  onEditLocation(): void;
  onRemoveLocation(id: string): void;
  onSettingsChange(settings: Settings): void;
  onClose(): void;
};

export function SettingsScreen({
  book,
  settings,
  saveFailed,
  headingRef,
  onSelectLocation,
  onAddLocation,
  onEditLocation,
  onRemoveLocation,
  onSettingsChange,
  onClose,
}: SettingsScreenProps) {
  const selected = selectedLocation(book);

  const handleRadiusChange = (event: ChangeEvent<HTMLSelectElement>) => {
    const next = radiusFromValue(event.target.value);
    if (next !== undefined) onSettingsChange({ ...settings, radiusKm: next });
  };

  const handleIntervalChange = (event: ChangeEvent<HTMLSelectElement>) => {
    const next = intervalMsFromValue(event.target.value);
    if (next !== undefined) onSettingsChange({ ...settings, intervalMs: next });
  };

  const handleKindChange = (event: ChangeEvent<HTMLSelectElement>) => {
    const next = kindOptionFromValue(event.target.value);
    if (next !== undefined) onSettingsChange({ ...settings, kindOption: next });
  };

  const handleAltitudeUnitChange = (event: ChangeEvent<HTMLSelectElement>) => {
    const next = altitudeUnitFromValue(event.target.value);
    if (next !== undefined) onSettingsChange({ ...settings, units: { ...settings.units, altitude: next } });
  };

  const handleSpeedUnitChange = (event: ChangeEvent<HTMLSelectElement>) => {
    const next = speedUnitFromValue(event.target.value);
    if (next !== undefined) onSettingsChange({ ...settings, units: { ...settings.units, speed: next } });
  };

  return (
    <main className="settings" aria-label={SETTINGS_TITLE}>
      <div className="settings-panel">
        <div className="settings-head">
          <h2 className="settings-title" ref={headingRef} tabIndex={-1}>
            {SETTINGS_TITLE}
          </h2>
          <button type="button" className="settings-close" onClick={onClose}>
            {SETTINGS_CLOSE_LABEL}
          </button>
        </div>

        {/* 保存に失敗したときだけ出す（localStorage が使えない・容量超過。plan「エラー処理について」2） */}
        <p className="settings-error" aria-live="polite">
          {saveFailed ? SAVE_FAILED_MESSAGE : ""}
        </p>

        <section className="settings-section" aria-label={LOCATION_SECTION_TITLE}>
          <h3 className="settings-section-title">{LOCATION_SECTION_TITLE}</h3>
          <ul className="settings-locations">
            {book.locations.map((location) => (
              <li key={location.id}>
                <label className="settings-location">
                  <input
                    type="radio"
                    name="settings-location"
                    value={location.id}
                    checked={location.id === selected?.id}
                    onChange={() => onSelectLocation(location.id)}
                  />
                  <span>{formatLocationOption(location)}</span>
                </label>
              </li>
            ))}
          </ul>
          <div className="settings-actions">
            <button type="button" className="settings-button" onClick={onAddLocation}>
              {LOCATION_ADD_LABEL}
            </button>
            <button
              type="button"
              className="settings-button"
              onClick={onEditLocation}
              disabled={selected === undefined}
            >
              {LOCATION_EDIT_LABEL}
            </button>
            <button
              type="button"
              className="settings-button"
              onClick={() => {
                if (selected !== undefined) onRemoveLocation(selected.id);
              }}
              disabled={!canRemoveLocation(book)}
            >
              {LOCATION_REMOVE_LABEL}
            </button>
          </div>
        </section>

        <section className="settings-section" aria-label={DISPLAY_SECTION_TITLE}>
          <h3 className="settings-section-title">{DISPLAY_SECTION_TITLE}</h3>
          <label className="settings-field">
            <span className="settings-field-label">{RADIUS_SELECT_LABEL}</span>
            <select
              className="settings-select"
              value={radiusOptionValue(settings.radiusKm)}
              onChange={handleRadiusChange}
            >
              {RADIUS_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
          <label className="settings-field">
            <span className="settings-field-label">{INTERVAL_SELECT_LABEL}</span>
            <select
              className="settings-select"
              value={intervalOptionValue(settings.intervalMs)}
              onChange={handleIntervalChange}
            >
              {INTERVAL_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
          <label className="settings-field">
            <span className="settings-field-label">{KIND_SELECT_LABEL}</span>
            <select className="settings-select" value={settings.kindOption} onChange={handleKindChange}>
              {KIND_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
          <label className="settings-field">
            <span className="settings-field-label">{ALTITUDE_UNIT_SELECT_LABEL}</span>
            <select className="settings-select" value={settings.units.altitude} onChange={handleAltitudeUnitChange}>
              {ALTITUDE_UNIT_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
          <label className="settings-field">
            <span className="settings-field-label">{SPEED_UNIT_SELECT_LABEL}</span>
            <select className="settings-select" value={settings.units.speed} onChange={handleSpeedUnitChange}>
              {SPEED_UNIT_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
        </section>

        {/* データ提供元のクレジット（AC-P2-73・仕様 §13）。フッターと同じ一覧を出す */}
        <section className="settings-section" aria-label={CREDITS_SECTION_TITLE}>
          <h3 className="settings-section-title">{CREDITS_SECTION_TITLE}</h3>
          <ul className="settings-credits">
            {CREDITS.map((credit) => (
              <li key={credit.id}>
                <a href={credit.href} target="_blank" rel="noopener noreferrer">
                  {credit.label}
                </a>
              </li>
            ))}
          </ul>
        </section>
      </div>
    </main>
  );
}
