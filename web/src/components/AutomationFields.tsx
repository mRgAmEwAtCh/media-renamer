import type { SettingsForm } from '../settings-form.ts';

type Toggle = 'autoEnabled' | 'autoWarnings' | 'autoCleanup' | 'audioFixEnabled' | 'audioFixEpisodes';

const TOGGLES: [Toggle, string][] = [
  ['autoEnabled', 'Import automatically when the downloader calls the hook'],
  ['autoWarnings', 'Also import files without a confident match (otherwise they wait for review)'],
  ['autoCleanup', 'Remove extraction folders that are left empty'],
  ['audioFixEnabled', 'Add a Dolby Digital Plus (E-AC-3) track to movies that only have DTS'],
  ['audioFixEpisodes', 'Also for TV episodes'],
];

interface AutomationFieldsProps {
  form: SettingsForm;
  hookStatus: string;
  bitrates: string[];
  update: (patch: Partial<SettingsForm>) => void;
}

/** What the import hook does with a finished download. */
export function AutomationFields({ form, hookStatus, bitrates, update }: AutomationFieldsProps) {
  return (
    <fieldset className="kind automation">
      <legend>Automatic import</legend>
      <p className="hint">{hookStatus}</p>
      {TOGGLES.map(([key, label]) => (
        <label key={key} className="checkbox">
          <input type="checkbox" checked={form[key]} onChange={(event) => update({ [key]: event.target.checked })} /> {label}
        </label>
      ))}
      <div className="grid">
        <label>
          Audio languages
          <input
            type="text"
            placeholder="e.g. de or de,en"
            spellCheck={false}
            autoComplete="off"
            value={form.audioLanguages}
            onChange={(event) => update({ audioLanguages: event.target.value })}
          />
        </label>
        <label>
          Bitrate of the added track
          <span className="select-control">
            <select value={form.audioBitrate} onChange={(event) => update({ audioBitrate: event.target.value })}>
              {bitrates.map((bitrate) => (
                <option key={bitrate} value={bitrate}>
                  {/^\d+k$/.test(bitrate) ? `${bitrate.slice(0, -1)} kbit/s` : bitrate}
                </option>
              ))}
            </select>
          </span>
        </label>
      </div>
      <p className="hint">The original DTS track is always kept. Atmos cannot be created with open-source tools, so the new track is 5.1.</p>
    </fieldset>
  );
}
