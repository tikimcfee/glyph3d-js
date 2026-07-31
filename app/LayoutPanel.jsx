import React, { useCallback, useEffect, useState } from 'react';
import { LAYOUT_SCHEMES, schemeNameOf } from '@glyph3d/core/collections/layouts/index.js';

/**
 * LayoutPanel — the field's layout controls. Where grid.layout folds ONE file,
 * this panel drives how the whole directory tree packs into the world: the
 * ContentTree's scheme (walk | district | …), switched live over the command
 * bus. The active scheme also shapes every future load — a directory-row
 * "load it all" (file.openDir) lands in whatever scheme is lit here.
 *
 * This is the home for the layout/marker control surface as it grows
 * (scheme knobs, directory markers — borders, bounds, pointers — later).
 *
 * House style mirrors FieldVisitorsPanel / HudPanel: a `client` prop, a light
 * poll (the tree doesn't emit), inline styles, command-bus side effects only.
 */

const S = {
    content: {
        width: '100%', height: '100%',
        background: 'rgba(8,10,14,0.92)',
        display: 'flex', flexDirection: 'column', overflow: 'hidden',
        font: '12px/1.55 ui-monospace, "JetBrains Mono", Menlo, monospace',
        color: '#c8ccd6',
    },
    header: {
        padding: '8px', borderBottom: '1px solid #1b1f29', color: '#7c8596',
        letterSpacing: '0.04em', flex: '0 0 auto',
        display: 'flex', alignItems: 'center', gap: 8,
    },
    count: { flex: '1 1 auto', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
    body: { overflowY: 'auto', flex: '1 1 auto', padding: '8px' },
    section: { color: '#7c8596', margin: '4px 0 6px', letterSpacing: '0.04em' },
    chips: { display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 12 },
    chip: (on) => ({
        cursor: 'pointer', padding: '3px 10px', borderRadius: 4, userSelect: 'none',
        border: `1px solid ${on ? '#7ad7a0' : '#2a3040'}`,
        color: on ? '#7ad7a0' : '#9aa3b2',
        background: on ? 'rgba(122,215,160,0.08)' : 'transparent',
    }),
    hint: { color: '#7c8596', fontSize: 11, lineHeight: 1.5 },
};

function readField(client) {
    const tree = client?.ctx?.contentTree;
    if (!tree) return { scheme: null, files: 0, dirs: 0, markers: false };
    return {
        scheme: schemeNameOf(tree.layout) || '(custom)',
        files: tree.paths().length,
        dirs: tree.dirCount(),
        markers: !!client?.ctx?.contentTreeMarkers?.enabled,
        arrows: !!client?.ctx?.contentTreeArrows?.enabled,
        labels: !!client?.ctx?.contentTreeLabels?.enabled,
    };
}

export default function LayoutPanel({ client }) {
    const [field, setField] = useState(() => readField(client));

    // The tree doesn't emit — a light poll keeps the lit chip + counts honest
    // no matter who relayouts (this panel, the CLI, a directory load).
    useEffect(() => {
        const refresh = () => setField(readField(client));
        refresh();
        const t = setInterval(refresh, 500);
        return () => clearInterval(t);
    }, [client]);

    const fire = useCallback((cmd) => {
        client?.router?.execute(cmd);
        setField(readField(client));
    }, [client]);

    return (
        <div style={S.content}>
            <div style={S.header}>
                <span style={S.count}>Field Layout · {field.files} files / {field.dirs} dirs</span>
            </div>
            <div style={S.body}>
                <div style={S.section}>packing scheme</div>
                <div style={S.chips}>
                    {Object.keys(LAYOUT_SCHEMES).map((name) => (
                        <span key={name} style={S.chip(field.scheme === name)}
                            onClick={() => fire(['layout.scheme', name])}
                            title={`layout.scheme ${name}`}>{name}</span>
                    ))}
                </div>
                <div style={S.section}>directory markers</div>
                <div style={S.chips}>
                    {['on', 'off'].map((state) => (
                        <span key={state} style={S.chip(field.markers === (state === 'on'))}
                            onClick={() => fire(['layout.markers', state])}
                            title={`layout.markers ${state}`}>{state}</span>
                    ))}
                </div>
                <div style={S.section}>order arrows</div>
                <div style={S.chips}>
                    {['on', 'off'].map((state) => (
                        <span key={state} style={S.chip(field.arrows === (state === 'on'))}
                            onClick={() => fire(['layout.arrows', state])}
                            title={`layout.arrows ${state}`}>{state}</span>
                    ))}
                </div>
                <div style={S.section}>container labels</div>
                <div style={S.chips}>
                    {['on', 'off'].map((state) => (
                        <span key={state} style={S.chip(field.labels === (state === 'on'))}
                            onClick={() => fire(['layout.labels', state])}
                            title={`layout.labels ${state}`}>{state}</span>
                    ))}
                </div>
                <div style={S.hint}>
                    The scheme packs the directory tree into the world — switching re-lays
                    the field in place, and every load (a file, a whole directory) arrives
                    in the active scheme. Markers draw a bounding prism per directory,
                    colored by a depth gradient; arrows thread each directory's child
                    dirs in reading order; labels name every visible directory, sized to
                    fit their container so deep names resolve as you approach. Dial knobs
                    from the command bar, e.g.{' '}
                    <code>layout.scheme --depth-z 150</code> or{' '}
                    <code>layout.labels --fit 0.6 --show-count 0</code>.
                </div>
            </div>
        </div>
    );
}
