import { useCallback, useEffect, useRef, useState } from 'react';
import { fieldLabel, PREVIEW_FIELDS, type SettingsForm } from '../settings-form.ts';
import type { SettingsState } from '../hooks/useSettings.ts';

type Choice = 'save' | 'discard' | 'cancel';

interface Ask {
  reason: string;
  changes: (keyof SettingsForm)[];
  resolve: (choice: Choice) => void;
}

function UnsavedDialog({ ask, busy, onChoose }: { ask: Ask; busy: boolean; onChoose: (choice: Choice) => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const element = dialog.current;
    if (element && !element.open) element.showModal();
    return () => element?.close();
  }, []);
  return (
    <dialog
      ref={dialog}
      className="confirm"
      aria-labelledby="unsaved-title"
      aria-describedby="unsaved-text"
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) onChoose('cancel');
      }}
    >
      <h2 id="unsaved-title">Unsaved settings</h2>
      <p id="unsaved-text">{ask.reason}</p>
      <ul className="changes">
        {ask.changes.map((key) => (
          <li key={key}>{fieldLabel(key)}</li>
        ))}
      </ul>
      <p className="hint">Saved settings are used by this page, by imports from the downloader and by the CLI.</p>
      <div className="row dialog-actions">
        <button type="button" className="primary" disabled={busy} onClick={() => onChoose('save')} autoFocus>
          Save
        </button>
        <button type="button" disabled={busy} onClick={() => onChoose('discard')}>
          Discard changes
        </button>
        <button type="button" disabled={busy} onClick={() => onChoose('cancel')}>
          Keep editing
        </button>
      </div>
    </dialog>
  );
}

/**
 * Asks to save or discard unsaved settings before they would silently differ
 * from what imports use. `confirmSettings` resolves to the form to work with,
 * or null when the user wants to keep editing (or saving failed).
 */
export function useUnsavedSettings(settings: SettingsState) {
  const [ask, setAsk] = useState<Ask | null>(null);
  const [busy, setBusy] = useState(false);
  const live = useRef(settings);
  useEffect(() => {
    live.current = settings;
  });

  const confirmSettings = useCallback(async (reason: string, { previewOnly = false } = {}): Promise<SettingsForm | null> => {
    const { changes, form } = live.current;
    const relevant = previewOnly ? changes.filter((key) => PREVIEW_FIELDS.has(key)) : changes;
    if (!relevant.length) return form;
    const choice = await new Promise<Choice>((resolve) => setAsk({ reason, changes: changes, resolve }));
    if (choice === 'cancel') {
      setAsk(null);
      return null;
    }
    if (choice === 'discard') {
      setAsk(null);
      return live.current.revert();
    }
    setBusy(true);
    const saved = await live.current.save();
    setBusy(false);
    setAsk(null);
    return saved;
  }, []);

  const dialog = ask && <UnsavedDialog ask={ask} busy={busy} onChoose={(choice) => ask.resolve(choice)} />;
  return { confirmSettings, dialog };
}
