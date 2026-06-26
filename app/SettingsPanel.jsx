import React, { useMemo, useState } from 'react';
import { SETTINGS, getSetting } from './client/settings.js';

// SettingsPanel — the IDE's settings surface. Renders the shared SETTINGS schema
// (one row per knob, grouped) and writes through the bus (settings.set / reset),
// so a panel change and a CLI `settings.set` are the same action. Persistence is
// client-only (StateController/localStorage) — settings survive a reload with no
// relay. Display knobs (font/atlas) are built at boot, so changing them flags a
// reload rather than pretending to apply live.

const styles = {
  content: {
    width: '100%', height: '100%', background: 'rgba(8,10,14,0.92)',
    display: 'flex', flexDirection: 'column', overflow: 'hidden',
    font: '12px/1.55 ui-monospace, "JetBrains Mono", Menlo, monospace', color: '#c8ccd6',
  },
  header: {
    padding: '8px', borderBottom: '1px solid #1b1f29', color: '#7c8596',
    letterSpacing: '0.04em', flex: '0 0 auto', display: 'flex', alignItems: 'center', gap: 8,
  },
  title: { flex: '1 1 auto' },
  reset: {
    flex: '0 0 auto', font: 'inherit', color: '#9aa3b2', background: 'transparent',
    border: '1px solid #232b34', borderRadius: 4, padding: '2px 8px', cursor: 'pointer',
  },
  rowReset: {
    flex: '0 0 auto', font: 'inherit', fontSize: 13, lineHeight: 1, color: '#7c8596',
    background: 'transparent', border: 'none', cursor: 'pointer', padding: '0 2px',
  },
  body: { padding: '6px 8px 12px', overflowY: 'auto', flex: '1 1 auto' },
  group: { color: '#5c6675', textTransform: 'uppercase', fontSize: 10, letterSpacing: '0.08em', margin: '12px 2px 4px' },
  row: { display: 'flex', alignItems: 'center', gap: 8, padding: '3px 2px' },
  label: { flex: '1 1 auto', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  reload: { color: '#caa14a', fontSize: 10, flex: '0 0 auto' },
  num: {
    width: 64, font: 'inherit', color: '#c8ccd6', background: '#0f141b',
    border: '1px solid #232b34', borderRadius: 4, padding: '2px 5px', outline: 'none', textAlign: 'right',
  },
  // Slider under each numeric row: min/max bounds flank an accent-tinted range input.
  sliderRow: { display: 'flex', alignItems: 'center', gap: 6, padding: '0 2px 5px' },
  slider: { flex: '1 1 auto', minWidth: 0, height: 16, cursor: 'pointer', accentColor: '#4a7f9a' },
  bound: { flex: '0 0 auto', fontSize: 9, color: '#5c6675', fontVariantNumeric: 'tabular-nums', minWidth: 28 },
  swatch: {
    width: 32, height: 20, padding: 0, background: '#0f141b',
    border: '1px solid #232b34', borderRadius: 4, cursor: 'pointer',
  },
  banner: {
    margin: '10px 2px 2px', padding: '6px 8px', borderRadius: 4, background: '#1c1606',
    border: '1px solid #4a3a12', color: '#d9b25a', display: 'flex', alignItems: 'center', gap: 8,
  },
  reloadBtn: {
    flex: '0 0 auto', font: 'inherit', color: '#08101a', background: '#caa14a',
    border: '1px solid #caa14a', borderRadius: 4, padding: '2px 10px', cursor: 'pointer', fontWeight: 600,
  },
};

export default function SettingsPanel({ client }) {
  const groups = useMemo(() => {
    const m = new Map();
    for (const s of SETTINGS) { if (!m.has(s.group)) m.set(s.group, []); m.get(s.group).push(s); }
    return [...m.entries()];
  }, []);

  // Controlled values, seeded from the store. Numbers are kept as strings so the
  // field can be empty mid-edit without snapping back; the bus write coerces.
  const [vals, setVals] = useState(() => {
    const o = {}; for (const s of SETTINGS) o[s.key] = getSetting(s.key); return o;
  });
  const [reloadPending, setReloadPending] = useState(false);

  const commit = (def, value) => {
    setVals((v) => ({ ...v, [def.key]: value }));
    // Don't write a half-typed / empty number — keep showing it until it's valid.
    if (def.type === 'number' && (value === '' || Number.isNaN(parseFloat(value)))) return;
    client?.router.execute(['settings.set', def.key, String(value)]);
    if (def.reload) setReloadPending(true);
  };

  const reset = () => {
    // A reload is needed only if a display knob is currently non-default (its baked
    // value would change). Compute before clearing.
    const needReload = SETTINGS.some((s) => s.reload && getSetting(s.key) !== s.default);
    client?.router.execute('settings.reset');
    const o = {}; for (const s of SETTINGS) o[s.key] = s.default; setVals(o);
    setReloadPending(needReload);
  };

  // Per-row reset to default — same bus verb with a key. A reload knob always flags
  // the banner (its baked value changes); the ↺ only shows when the row is off-default.
  const resetOne = (def) => {
    client?.router.execute(['settings.reset', def.key]);
    setVals((v) => ({ ...v, [def.key]: def.default }));
    if (def.reload) setReloadPending(true);
  };

  // Is the row's current value different from its default? Numbers/bools coerce so a
  // mid-edit string ("0.30") still compares right. Doubles as the "modified" cue.
  const isModified = (def) => {
    const cur = vals[def.key];
    if (def.type === 'number') return parseFloat(cur) !== def.default;
    if (def.type === 'bool') return !!cur !== def.default;
    return cur !== def.default;
  };

  return (
    <div style={styles.content}>
      <div style={styles.header}>
        <span style={styles.title}>settings</span>
        <button type="button" style={styles.reset} onClick={reset} title="reset all settings to defaults">reset</button>
      </div>
      <div style={styles.body}>
        {groups.map(([group, defs]) => (
          <div key={group}>
            <div style={styles.group}>{group}</div>
            {defs.map((def) => (
              <div key={def.key}>
                <div style={styles.row}>
                  <span style={styles.label} title={def.key}>{def.label}</span>
                  {def.reload && <span style={styles.reload}>reload</span>}
                  {isModified(def) && (
                    <button
                      type="button"
                      style={styles.rowReset}
                      title={`reset to default (${def.default})`}
                      onClick={() => resetOne(def)}
                    >↺</button>
                  )}
                  {def.type === 'color' ? (
                    <input
                      type="color"
                      style={styles.swatch}
                      value={vals[def.key]}
                      onChange={(e) => commit(def, e.target.value)}
                    />
                  ) : def.type === 'bool' ? (
                    <input
                      type="checkbox"
                      checked={!!vals[def.key]}
                      onChange={(e) => commit(def, e.target.checked)}
                    />
                  ) : (
                    <input
                      type="number"
                      style={styles.num}
                      value={vals[def.key]}
                      min={def.min} max={def.max} step={def.step}
                      onChange={(e) => commit(def, e.target.value)}
                      onKeyDown={(e) => e.stopPropagation()}
                    />
                  )}
                </div>
                {/* Slider under each numeric row — min/max bounds + drag for quick
                    tweaks; shares commit() with the number field, so they stay in sync. */}
                {def.type === 'number' && (
                  <div style={styles.sliderRow}>
                    <span style={{ ...styles.bound, textAlign: 'right' }}>{def.min}</span>
                    <input
                      type="range"
                      style={styles.slider}
                      min={def.min} max={def.max} step={def.step}
                      value={Number.isFinite(parseFloat(vals[def.key])) ? parseFloat(vals[def.key]) : def.default}
                      onChange={(e) => commit(def, e.target.value)}
                      onKeyDown={(e) => e.stopPropagation()}
                    />
                    <span style={{ ...styles.bound, textAlign: 'left' }}>{def.max}</span>
                  </div>
                )}
              </div>
            ))}
          </div>
        ))}
        {reloadPending && (
          <div style={styles.banner}>
            <span style={{ flex: '1 1 auto' }}>Display changes need a reload.</span>
            <button type="button" style={styles.reloadBtn} onClick={() => window.location.reload()}>Reload</button>
          </div>
        )}
      </div>
    </div>
  );
}
