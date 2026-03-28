# Predictions: display

## What I expect "interaction" concluded

The interaction agent focused on click-to-focus via raycasting against CodeGrid bounding boxes, maintaining a `focusedWindowId` on the manager, and routing keyboard events only to the focused window. They likely proposed a `FocusManager` or added focus state directly to TUIWindowManager, with a visual indicator (border color change or highlight) on the focused window's CodeGrid. For cursor rendering, they probably concluded that a blinking cursor can be done by toggling a special character or color at the cursor position during `_render()`, updating on a `setInterval`. Their key concern is that the existing CameraController's InputManager will conflict with window keystroke capture -- they proposed a modal input system where focus on a TUI window suppresses camera controls and redirects keystrokes to the window's buffer.

## What I expect "orchestration" concluded

The orchestration agent designed the cross-ref agent window lifecycle: each perspective agent gets a dedicated TUI window created via `window.create` at run start, with agent output streamed via `window.append` as the agent works. They proposed a layout strategy that tiles agent windows side-by-side (or in a grid) based on agent count, using fixed position offsets from TUIWindowManager's auto-positioning. Their main concern is coordination timing -- ensuring windows are created before agent output starts flowing, and that the cross-review rounds (forward/inverse) reuse or relabel existing windows rather than creating new ones. They likely added a `crossRefLayout` function or extended the cross-ref skill to emit `window.*` WebSocket commands, tracking window IDs by agent name in a map.
