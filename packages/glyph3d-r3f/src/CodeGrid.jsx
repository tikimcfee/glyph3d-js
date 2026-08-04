import React, { useEffect, useRef, forwardRef } from 'react';
import { useThree } from '@react-three/fiber';
import { CodeGrid as CodeGridCore } from '@glyph3d/core/collections';
import { useGlyphAtlas, useGridRegistry } from './context.jsx';

const toXYZ = (p) => (Array.isArray(p) ? p : [p?.x ?? 0, p?.y ?? 0, p?.z ?? 0]);
const assignRef = (ref, value) => {
  if (typeof ref === 'function') ref(value);
  else if (ref) ref.current = value;
};

/**
 * <CodeGrid> — a declarative wrapper over the core CodeGrid Object3D.
 *
 * Construction-time options (worldScale, textColor, showBackground, maxChars,
 * name) are applied on mount; change them by changing the React `key` to force a
 * remount (kept explicit rather than silently rebuilding on every prop change).
 * `text`/`filename` and `position` ARE reactive.
 *
 * Honors the core contract discovered in the keystone: the constructor's
 * scene.add is dead (it re-parents the render group to itself), so the caller
 * MUST scene.add(grid). We do that here, plus register/unregister with the grid
 * registry so the camera and other subsystems can see it.
 *
 * @param {object} props
 * @param {string}  props.text                 - File/text content to render.
 * @param {string}  [props.filename]           - Filename label.
 * @param {[number,number,number]|{x,y,z}} [props.position] - World position.
 * @param {number}  [props.worldScale=0.025]   - World units per atlas pixel.
 * @param {{r,g,b}} [props.textColor]          - Default glyph color (0..1).
 * @param {boolean} [props.showBackground=true]
 * @param {number}  [props.maxChars]
 * @param {string}  [props.name]
 * @param {React.Ref} ref - Exposes the core CodeGrid instance.
 */
const CodeGrid = forwardRef(function CodeGrid({
  text = '',
  filename = '',
  position,
  worldScale = 0.025,
  textColor,
  showBackground = true,
  maxChars,
  name,
  occluder = false,
}, ref) {
  const scene = useThree((s) => s.scene);
  const atlas = useGlyphAtlas();
  const { addGrid, removeGrid } = useGridRegistry();
  const gridRef = useRef(null);

  // Mount: build the core, attach, register. Teardown: unregister, remove, dispose.
  // Construction-time options are intentionally NOT in the dep array (remount via
  // `key` to change them); text/filename load happens in a separate effect.
  useEffect(() => {
    const grid = new CodeGridCore(scene, atlas, {
      name: name ?? filename ?? 'CodeGrid',
      worldScale,
      showBackground,
      ...(textColor ? { textColor } : {}),
      ...(maxChars ? { maxChars } : {}),
      ...(occluder ? { occluder: true } : {}),
    });
    scene.add(grid); // required — see contract note above
    addGrid(grid, { id: filename || name, type: 'grid' });
    gridRef.current = grid;
    assignRef(ref, grid);

    return () => {
      removeGrid(grid);
      scene.remove(grid);
      grid.dispose?.();
      gridRef.current = null;
      assignRef(ref, null);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scene, atlas, addGrid, removeGrid]);

  // Reactive content load.
  useEffect(() => {
    const grid = gridRef.current;
    if (!grid) return;
    void grid.loadFile(filename, text);
  }, [text, filename]);

  // Reactive position.
  useEffect(() => {
    const grid = gridRef.current;
    if (!grid || position == null) return;
    grid.position.set(...toXYZ(position));
  }, [position]);

  return null;
});

export default CodeGrid;
