import { useState, type RefObject } from 'react';
import type { SettingsForm } from '../settings-form.ts';
import type { SettingsState } from '../hooks/useSettings.ts';
import { AutomationFields } from './AutomationFields.tsx';

const LANGUAGES: [string, string][] = [
  ['de-DE', 'Deutsch'],
  ['en-US', 'English (US)'],
  ['en-GB', 'English (UK)'],
  ['fr-FR', 'Français'],
  ['es-ES', 'Español'],
  ['it-IT', 'Italiano'],
  ['nl-NL', 'Nederlands'],
  ['pt-BR', 'Português (Brasil)'],
  ['pl-PL', 'Polski'],
  ['sv-SE', 'Svenska'],
  ['ja-JP', '日本語'],
];
const REGIONS: [string, string][] = [
  ['DE', 'Deutschland'],
  ['AT', 'Österreich'],
  ['CH', 'Schweiz'],
  ['US', 'United States'],
  ['GB', 'United Kingdom'],
  ['FR', 'France'],
];

function LocaleField({ kind, value, onChange }: { kind: 'language' | 'region'; value: string; onChange: (value: string) => void }) {
  const [custom, setCustom] = useState(false);
  const options = kind === 'language' ? LANGUAGES : REGIONS;
  const isCustom = custom || Boolean(value && !options.some(([code]) => code === value));
  return (
    <div className="field locale-field">
      <label htmlFor={kind}>{kind === 'language' ? 'Language' : 'Region (movies)'}</label>
      <div className="select-control">
      <select
        id={kind}
        value={isCustom ? 'custom' : value}
        onChange={(event) => {
          const next = event.target.value;
          setCustom(next === 'custom');
          if (next !== 'custom') onChange(next);
        }}
      >
        <option value="" disabled={kind === 'language'}>{kind === 'language' ? 'Choose a language' : 'No region preference'}</option>
        {options.map(([code, label]) => (
          <option key={code} value={code}>{`${label} (${code})`}</option>
        ))}
        <option value="custom">{kind === 'language' ? 'Custom language…' : 'Custom region…'}</option>
      </select>
      </div>
      {isCustom && (
        <label className="custom-locale">
          {kind === 'language' ? 'Custom language code' : 'Custom region code'}
          <input
            type="text"
            placeholder={kind === 'language' ? 'e.g. da-DK' : 'e.g. DK'}
            maxLength={kind === 'region' ? 2 : undefined}
            spellCheck={false}
            autoComplete="off"
            value={value}
            onChange={(event) => onChange(event.target.value)}
          />
        </label>
      )}
    </div>
  );
}

interface KindFieldsProps {
  legend: string;
  patternLabel: string;
  pattern: keyof SettingsForm & ('episodePattern' | 'moviePattern');
  target: keyof SettingsForm & ('tvTarget' | 'movieTarget');
  targetLabel: string;
  placeholder: string;
  settings: SettingsState;
  busy: boolean;
  browseButton: RefObject<HTMLButtonElement | null>;
  onBrowse: () => void;
}

/** Pattern and destination for TV shows or for movies. */
function KindFields({ legend, patternLabel, pattern, target, targetLabel, placeholder, settings, busy, browseButton, onBrowse }: KindFieldsProps) {
  const { form, update } = settings;
  return (
    <fieldset className="kind">
      <legend>{legend}</legend>
      <label>
        {patternLabel} <input type="text" spellCheck={false} value={form[pattern]} onChange={(event) => update({ [pattern]: event.target.value })} />
      </label>
      {form.move && (
        <div className="field target-field">
          <label htmlFor={target}>{targetLabel}</label>
          <div className="input-group">
            <input
              id={target}
              type="text"
              placeholder={placeholder}
              autoComplete="off"
              spellCheck={false}
              value={form[target]}
              onChange={(event) => update({ [target]: event.target.value })}
            />
            <button ref={browseButton} type="button" disabled={busy} onClick={onBrowse}>
              Browse…
            </button>
          </div>
        </div>
      )}
    </fieldset>
  );
}

function DefaultsStatus({ settings }: { settings: SettingsState }) {
  const { dirty, saved } = settings;
  let text = 'Using the server’s defaults. Nothing saved yet.';
  if (dirty) text = 'Unsaved changes. “Save” keeps them for all browsers and the CLI.';
  else if (saved.exists) text = `Using your saved defaults${saved.at ? ` (${new Date(saved.at).toLocaleString()})` : ''}.`;
  return (
    <span id="defaultsStatus" className={dirty ? 'hint dirty' : 'hint'} aria-live="polite">
      {text}
    </span>
  );
}

interface NamingPanelProps {
  settings: SettingsState;
  busy: boolean;
  browseButtons: { tv: RefObject<HTMLButtonElement | null>; movie: RefObject<HTMLButtonElement | null> };
  onBrowseTarget: (kind: 'tv' | 'movie') => void;
}

/** The Settings view: naming patterns, destinations, metadata language and automatic import. */
export function NamingPanel({ settings, busy, browseButtons, onBrowseTarget }: NamingPanelProps) {
  const { form, update, dirty, saved, server, bitrates } = settings;
  const shared = { settings, busy };
  return (
    <section className="panel" aria-labelledby="naming-heading">
      <h2 id="naming-heading">Naming &amp; destinations</h2>
      <label className="checkbox move-toggle">
        <input type="checkbox" checked={form.move} onChange={(event) => update({ move: event.target.checked })} /> Move renamed files into my
        library folders
      </label>
      <div className="kinds">
        <KindFields
          {...shared}
          legend="TV shows"
          patternLabel="Episode pattern"
          pattern="episodePattern"
          target="tvTarget"
          targetLabel="Destination for TV shows"
          placeholder="Empty: rename episodes in place"
          browseButton={browseButtons.tv}
          onBrowse={() => onBrowseTarget('tv')}
        />
        <KindFields
          {...shared}
          legend="Movies"
          patternLabel="Movie pattern"
          pattern="moviePattern"
          target="movieTarget"
          targetLabel="Destination for movies"
          placeholder="Empty: rename movies in place"
          browseButton={browseButtons.movie}
          onBrowse={() => onBrowseTarget('movie')}
        />
      </div>
      <div className="grid">
        <LocaleField kind="language" value={form.language} onChange={(language) => update({ language })} />
        <LocaleField kind="region" value={form.region} onChange={(region) => update({ region })} />
      </div>
      <AutomationFields form={form} hookStatus={server.hookStatus} bitrates={bitrates} update={update} />
      <p className="hint">{server.tmdbStatus}</p>
      <p className="hint">
        Tokens: <code>{'{n}'}</code> name, <code>{'{y}'}</code> year, <code>{'{s}'}</code>/<code>{'{s00}'}</code> season, <code>{'{e}'}</code>/
        <code>{'{e00}'}</code> episode, <code>{'{s00e00}'}</code>, <code>{'{sxe}'}</code>, <code>{'{t}'}</code> episode title, <code>{'{d}'}</code> air
        date, <code>{'{on}'}</code> original title. A <code>/</code> creates folders, e.g. <code>{'{n}/Season {s}/{s00e00} {t}'}</code>. Moved files
        start at the destination; files renamed in place keep their subfolder.
      </p>
      <div className="row defaults">
        <button type="button" className="primary" disabled={busy || !dirty} onClick={settings.save}>
          Save
        </button>
        <button type="button" disabled={busy || !dirty} onClick={settings.revert}>
          Discard changes
        </button>
        <button type="button" disabled={busy || !saved.exists} onClick={settings.reset}>
          Reset to server defaults
        </button>
        <DefaultsStatus settings={settings} />
      </div>
    </section>
  );
}
