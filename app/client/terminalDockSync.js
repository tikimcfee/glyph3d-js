/**
 * terminalDockSync — wire a dockview group (the Terminals panel) to the terminal registry +
 * attention, returning the sync entrypoints.
 *
 * The hard part is telling a USER tab activation (click/drag → take focus + frame the terminal in
 * 3D) from a PROGRAMMATIC one we caused: a panel added into the group's mandatory active slot as a
 * terminal re-adopts on restore, or an attention→tab raise. dockview fires `onDidActivePanelChange`
 * for BOTH, and — the trap — sometimes on a later microtask. So a boolean "are we mid-sync" flag
 * races the event: by the time the activation fires, the flag has cleared, and the restore-time
 * activation leaks through as if the user clicked a tab — taking focus AND flying the camera, which
 * clobbers the just-restored pose + attention (the launch-reset bug).
 *
 * Fix: match by IDENTITY, not timing. Every activation we initiate is recorded by id and consumed
 * silently when its event arrives — whenever that is. The set is timing-proof by construction: sync
 * or async, the event for that id is recognised as ours. Only an UN-recorded activation is user
 * intent, and only that takes focus + frames.
 *
 * @param {object} api dockview group api (addPanel/getPanel/panels/onDidActivePanelChange)
 * @param {{ getClient: () => object, listTerminalIds: (client: object) => string[] }} deps
 * @returns {{ syncPanels: Function, syncActive: Function, dispose: Function }}
 */
export function wireTerminalDock(api, { getClient, listTerminalIds }) {
  /** ids of activations WE initiated, awaiting their (possibly-async) dockview event. */
  const programmatic = new Set();
  const primaryId = () => getClient()?.ctx?.attentionManager?.get('primary')?.id ?? null;
  const exec = (cmd) => getClient()?.router?.execute(cmd);

  // attention → active tab: raise the panel for the primary slot (no-op if already active). The
  // setActive is ours, so record the id first — its activation event must stay silent.
  const syncActive = () => {
    const id = primaryId();
    if (!id) return;
    const p = api.getPanel(id);
    if (p && !p.api.isActive) { programmatic.add(id); p.api.setActive(); }
  };

  // registry → panels: add a panel per new terminal, close panels for killed ones. A group must
  // have one active panel, so the first add lands active; a later add lands active only if it's the
  // attention primary. Either way that id is OUR activation — record it. All other adds land
  // inactive (attention, not panel-add, decides focus).
  const syncPanels = () => {
    const live = listTerminalIds(getClient());
    const liveIds = new Set(live);
    for (const p of [...api.panels]) if (!liveIds.has(p.id)) p.api.close();
    for (const id of live) {
      if (api.getPanel(id)) continue;
      const addActive = api.panels.length === 0 || primaryId() === id;
      if (addActive) programmatic.add(id);
      api.addPanel({
        id, component: 'terminal', tabComponent: 'terminal',
        params: { termId: id },
        inactive: !addActive,
      });
    }
    syncActive();
  };

  // active tab → focus: a USER activation (tab click/drag) takes focus + frames it. An activation we
  // initiated is consumed silently — identity-matched, so dockview's async event timing can't leak
  // a launch-restore activation through to fly the camera or hijack focus.
  const sub = api.onDidActivePanelChange((panel) => {
    if (!panel) return;
    if (programmatic.delete(panel.id)) return;   // our own activation → silent
    if (primaryId() === panel.id) return;        // already focused → no-op echo
    exec(`terminal.focus ${panel.id}`);
    exec(`camera.focus ${panel.id}`);
  });

  return { syncPanels, syncActive, dispose: () => sub?.dispose?.() };
}
