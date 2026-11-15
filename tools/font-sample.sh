#!/bin/sh
# font-sample.sh — one screenful (80 columns, 23 lines) of text for judging a terminal font family
# by eye: each of its four faces (regular, bold, italic, bold-italic), a code sample with the
# faces where an editor puts them, a paragraph of prose, the look-alikes and operators, and
# accented text — precomposed, and typed as a letter plus combining marks.
#
#   sh tools/font-sample.sh          print it (the screen is cleared first)
#   sh tools/font-sample.sh --keep   print it below what is already on screen
#
# tools/font-faces-shots.mjs photographs it on the wall in every font family.

e=$(printf '\033')
r="${e}[0m"
b="${e}[1m" i="${e}[3m" bi="${e}[1;3m"
k="${e}[1;38;5;175m" s="${e}[38;5;114m" c="${e}[3;38;5;245m" n="${e}[38;5;215m" f="${e}[38;5;75m"
# Combining marks, spelled as bytes so an editor can't compose them away.
ACUTE=$(printf '\314\201') CIRC=$(printf '\314\202') TILDE=$(printf '\314\203') MACRON=$(printf '\314\204')
DIAER=$(printf '\314\210') DOTBELOW=$(printf '\314\243') DACUTE=$(printf '\314\213')
[ "$1" = "--keep" ] || printf '%s' "${e}[H${e}[2J"

# 1-4: the four faces
printf '%s\n' "regular      The quick brown fox jumps over the lazy dog. 0123456789 @#\$%&*"
printf '%s\n' "${b}bold         The quick brown fox jumps over the lazy dog. 0123456789 @#\$%&*${r}"
printf '%s\n' "${i}italic       The quick brown fox jumps over the lazy dog. 0123456789 @#\$%&*${r}"
printf '%s\n' "${bi}bold italic  The quick brown fox jumps over the lazy dog. 0123456789 @#\$%&*${r}"
printf '\n'
# 6-13: code
printf '%s\n' "${c}// Route a cell's glyph by its face: bold, italic, or both.${r}"
printf '%s\n' "${k}export function${r} ${f}lookupFace${r}(codepoint, face, family = ${n}0${r}) {"
printf '%s\n' "    ${k}const${r} fontIdx = ${k}this${r}.${f}routeCodepoint${r}(codepoint, family);"
printf '%s\n' "    ${k}if${r} (face !== ${n}0${r} && fontIdx >= ${n}0${r} && !isSprite(codepoint)) {"
printf '%s\n' "        ${k}return${r} { g: slots[fontIdx][face] ?? ${n}-1${r}, name: ${s}'Monaspace → é'${r} };"
printf '%s\n' "    }"
printf '%s\n' "    ${k}return${r} ${k}this${r}.${f}lookup${r}(codepoint, family);   ${c}// 0x1F600 <= cp || a != b${r}"
printf '%s\n' "}"
printf '\n'
# 15-18: prose
printf '%s\n' "A terminal is a ${b}reading instrument${r}: most of what it shows is prose, logs and"
printf '%s\n' "code, set in one size and ${i}one width${r}. A family earns its place by how its"
printf '%s\n' "${b}bold${r} sits beside its regular, how its ${i}italic${r} leans without thinning, and"
printf '%s\n' "whether ${bi}il1I O0o rn m${r} stay apart at twelve pixels as they do at forty."
printf '\n'
# 20-23: look-alikes and operators; accents, precomposed and as letter + combining mark(s)
printf '%s\n' "il1I| O0o 5S 2Z 8B rn m  {}[]()<>  -> => != == === <= >= :: || && ++ -- /* */ #!"
printf '%s\n' "${b}il1I| O0o 5S 2Z 8B rn m  {}[]()<>  -> => != == === <= >= :: || && ++ -- /* */ #!${r}"
printf '%s\n' "précomposé  café naïve jalapeño Việt Nam coöperate Ærø straße Łódź ångström"
printf '%s' "combining   cafe${ACUTE} nai${DIAER}ve jalapen${TILDE}o Vie${DOTBELOW}${CIRC}t Nam x${ACUTE} q${DIAER}${MACRON} ${b}o${DACUTE} n${TILDE} x${ACUTE}${r} ${i}e${ACUTE} a${CIRC}${ACUTE} x${ACUTE}${r} ${bi}u${DIAER} x${ACUTE}${r}"
exit 0
