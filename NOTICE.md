# Third-party notices

## Multica

glyph3d's `@glyph3d/multica` package and its `multica.*` commands are built on
**Multica** — <https://github.com/multica-ai/multica>.

Multica is distributed under the **Multica License**: the complete text of the Apache
License 2.0 together with additional conditions covering hosted or embedded commercial
use, branding displayed by a Multica user interface, and attribution for non-interface
use. It is *not* plain Apache-2.0, and the additional conditions control where the two
conflict.

### What we ship, and why that matters

`@glyph3d/multica` contains **no Multica source code**. It is a client: it speaks the
Multica backend's HTTP and WebSocket protocol the same way any network client speaks to
a server it does not vendor. The wire shapes are described in our own JSDoc typedefs
(`packages/glyph3d-multica/src/types.js`), written against a running server.

glyph3d therefore remains MIT-licensed in full, and the Multica License's conditions
apply to *operating a Multica backend*, not to this repository's code.

Two consequences that constrain how this integration may be developed:

- **We do not derive from Multica's UI.** The Multica License defines a "Multica user
  interface" as one derived, in whole or substantial part, from the code in `apps/web/`,
  `apps/desktop/`, `apps/mobile/`, `packages/views/`, or `packages/ui/` — and says that
  coverage follows the code when it is modified, moved, renamed, or extracted. glyph3d's
  renderer is derived from none of it. Porting components out of those directories would
  pull the branding condition over our UI, so it must not be done.
  `tools/multica-up.sh` accordingly runs the backend only and never builds their
  frontend.

- **Operating a Multica backend is the operator's decision, not ours.** The license
  restricts offering Multica as a hosted service to third parties, or embedding it in a
  commercially distributed product, without a commercial license from the producer.
  Running an instance for yourself or inside a single organization does not. glyph3d
  ships no Multica instance and starts none on a user's behalf beyond the local
  development script.

Publishing this integration's source — including in a public fork — is expressly not a
hosted service under the Multica License, and needs no commercial license.

### Attribution

Per the Multica License's attribution condition for consumers of the backend, daemon, or
CLI without a Multica user interface:

> This product is built on Multica — <https://github.com/multica-ai/multica>.

Copyright 2025-2026 Multica, Inc. See that repository's `LICENSE` and `NOTICE` files for
the complete terms.
