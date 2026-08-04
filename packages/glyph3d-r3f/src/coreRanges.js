// LARGE_CORE_RANGES — the codepoint ranges primed + encoded into the slug core up front, so
// the live atlas rarely grows mid-session. The single source of truth shared by the runtime
// (glyphEngine.js) AND the build-time bake (tools/bake-slug-core.mjs) — both feed it into the
// content-addressed cache key, so they MUST agree or a baked asset won't be found at runtime.
// Dependency-free on purpose (no DOM, no @glyph3d/core) so the headless bake can import it.
//
// Codepoints the font chain doesn't cover resolve to .notdef (glyph 0) and are skipped by the
// encoder, so this list is generous without waste — only font-covered glyphs cost anything.
// Deliberately bounded: NO full CJK / kana (no chain font covers them — they render through
// the color-bitmap branch, and priming 27k dead codepoints would only tax boot) and NO giant
// Nerd-Font icon PUA (thousands of rarely-used icons — those stay cheap live-encodes).
//
// The tail entries are CORPUS-COMPUTED (2026-08-04): the codepoint universe of this repo's
// real workload (source tree + claude/kimi transcripts, 260MB) minus the prior ranges,
// intersected with font-chain coverage — 62 codepoints, the complete set that could fire a
// live growth on this corpus. Chief among them: the zero-width VARIATION SELECTORS that ride
// every emoji (the recurring '+1 [.blank]' growths) and DejaVu's monochrome emoji spans.
export const LARGE_CORE_RANGES = [
  [0x0020, 0x007e], // ASCII printable
  [0x00a0, 0x024f], // Latin-1 Supplement + Latin Extended-A/B
  [0x0250, 0x02ff], // IPA + spacing modifiers
  [0x0300, 0x036f], // combining diacriticals
  [0x0370, 0x03ff], // Greek
  [0x0400, 0x04ff], // Cyrillic
  [0x0590, 0x05ff], // Hebrew
  [0x0600, 0x06ff], // Arabic
  [0x1680, 0x1680], // ogham space mark (corpus-computed)
  [0x1e00, 0x1eff], // Latin Extended Additional
  [0x2000, 0x206f], // general punctuation
  [0x2070, 0x20cf], // super/subscripts + currency
  [0x2100, 0x218f], // letterlike + number forms
  [0x2190, 0x21ff], // arrows
  [0x2200, 0x22ff], // mathematical operators
  [0x2300, 0x23ff], // miscellaneous technical
  [0x2400, 0x24ff], // control pictures + enclosed alphanumerics
  [0x2500, 0x257f], // box drawing
  [0x2580, 0x259f], // block elements
  [0x25a0, 0x25ff], // geometric shapes
  [0x2600, 0x26ff], // miscellaneous symbols
  [0x2700, 0x27bf], // dingbats
  [0x2800, 0x28ff], // braille patterns
  [0x2900, 0x297f], // supplemental arrows-B
  [0x2a00, 0x2aff], // supplemental mathematical operators
  [0x2b00, 0x2bff], // misc symbols & arrows
  [0xe0a0, 0xe0d4], // powerline (private use)
  [0xfe00, 0xfe0f], // variation selectors — zero-width, ride every emoji (corpus-computed)
  [0xfff0, 0xffff], // specials (replacement char U+FFFD)
  [0x1f400, 0x1f64f], // font-covered emoji: animal faces + the emoticons block (corpus-computed)
];
