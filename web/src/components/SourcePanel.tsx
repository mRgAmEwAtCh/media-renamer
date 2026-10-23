import type { RefObject } from 'react';
import type { SettingsForm } from '../settings-form.ts';

interface SourcePanelProps {
  root: string;
  recursive: boolean;
  form: SettingsForm;
  busy: boolean;
  browseButton: RefObject<HTMLButtonElement | null>;
  onRootChange: (root: string) => void;
  onRecursiveChange: (recursive: boolean) => void;
  onFiltersChange: (patch: Pick<Partial<SettingsForm>, 'videoOnly' | 'excludeSamples'>) => void;
  onBrowse: () => void;
  onScan: () => void;
}

/** Step 1: the folder to rename and which files to include. */
export function SourcePanel(props: SourcePanelProps) {
  const { root, recursive, form, busy } = props;
  return (
    <section className="panel" aria-labelledby="source-heading">
      <h2 id="source-heading">1. Choose a folder</h2>
      <div className="row">
        <div className="field grow">
          <label htmlFor="root">Folder path</label>
          <div className="input-group">
            <input
              id="root"
              type="text"
              placeholder="Click Browse… or type a path"
              autoComplete="off"
              spellCheck={false}
              value={root}
              onChange={(event) => props.onRootChange(event.target.value)}
              onKeyDown={(event) => event.key === 'Enter' && props.onScan()}
            />
            <button ref={props.browseButton} type="button" disabled={busy} onClick={props.onBrowse}>
              Browse…
            </button>
          </div>
        </div>
        <label className="checkbox">
          <input type="checkbox" checked={recursive} onChange={(event) => props.onRecursiveChange(event.target.checked)} /> Include subfolders
        </label>
        <label className="checkbox">
          <input type="checkbox" checked={form.videoOnly} onChange={(event) => props.onFiltersChange({ videoOnly: event.target.checked })} /> Video
          files only
        </label>
        <label className="checkbox">
          <input
            type="checkbox"
            checked={form.excludeSamples}
            onChange={(event) => props.onFiltersChange({ excludeSamples: event.target.checked })}
          />{' '}
          Skip sample files
        </label>
        <button type="button" disabled={busy} onClick={props.onScan}>
          Scan
        </button>
      </div>
    </section>
  );
}
