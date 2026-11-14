#!/bin/sh
# term-test-pattern.sh — one screenful (80 columns, 22 lines) of what a terminal draws itself rather than
# taking from a font, for a person to judge by eye: block art, blocks and shades, box drawing, a divider,
# braille, sextants and wedges, powerline separators, every SGR style, inverse and dim, a wide
# emoji on a coloured background, and plain text beside them.
#
#   sh tools/term-test-pattern.sh          print it (the screen is cleared first)
#   sh tools/term-test-pattern.sh --keep   print it below what is already on screen
#
# What to look for: no dark seams between █ cells (across or down), ─ and │ runs unbroken, corners
# meeting their lines, underlines / strikes / overlines continuous across cells, the curly underline
# in its own colour, the emoji whole on its background.

e=$(printf '\033')
r="${e}[0m"
# Powerline separators (private use, U+E0B0–E0BF), spelled as bytes so an editor can't lose them.
pl() { printf "\\356\\202\\$1"; }
P0=$(pl 260) P1=$(pl 261) P2=$(pl 262) P3=$(pl 263) P4=$(pl 264) P5=$(pl 265) P6=$(pl 266) P7=$(pl 267)
P8=$(pl 270) P9=$(pl 271) PA=$(pl 272) PB=$(pl 273) PC=$(pl 274) PD=$(pl 275) PE=$(pl 276) PF=$(pl 277)
[ "$1" = "--keep" ] || printf '%s' "${e}[H${e}[2J"

# 1-3: block art (the Claude Code figure), blocks, shades, eighths, quadrants
printf '%s\n' " ${e}[38;5;209m▐▛███▜▌${r}   full ████████ ▀▀▀▀▄▄▄▄ shades ░░░▒▒▒▓▓▓███ eighths ▁▂▃▄▅▆▇█ ▏▎▍▌▋▊▉█"
printf '%s\n' "${e}[38;5;209m▝▜█████▛▘${r}  rows ████████ ▌▌▌▌▐▐▐▐ quads  ▖▗▘▝▙▚▛▜▞▟   ${e}[38;5;75m████${e}[38;5;114m████${e}[38;5;221m████${e}[38;5;203m████${r} ▔▔▁▁▕▏"
printf '%s\n' "${e}[38;5;209m  ▘▘ ▝▝${r}    cols ████████ ▙▟▛▜▚▞▙▟ ${e}[48;5;24m ▄▀▄▀ on a fill ▐▌▐▌ ${r} ${e}[38;5;75m████${e}[38;5;114m████${e}[38;5;221m████${e}[38;5;203m████${r} ▁▂▃▂▁"

# 4-6: box drawing — light, heavy, double, rounded, mixed joins; dashes, diagonals, half lines
printf '%s\n' "┌──┬──┐ ┏━━┳━━┓ ╔══╦══╗ ╭──┬──╮ ┍━━┯━━┑ ╒══╤══╕ ┎──┰──┒ ╓──╥──╖ ╌╌╌ ┄┄┄ ┈┈┈ ╱╲╳╱"
printf '%s\n' "├──┼──┤ ┣━━╋━━┫ ╠══╬══╣ │  │  │ ┝━━┿━━┥ ╞══╪══╡ ┠──╂──┨ ╟──╫──╢ ╍╍╍ ┅┅┅ ┉┉┉ ╲╱╳╲"
printf '%s\n' "└──┴──┘ ┗━━┻━━┛ ╚══╩══╝ ╰──┴──╯ ┕━━┷━━┙ ╘══╧══╛ ┖──┸──┚ ╙──╨──╜ ╎┆┊ ╴╵╶╷╸╹╺╻╼╽╾╿"

# 7-11: a drawn table, nested rounded boxes, heavy and light joined, every mixed join
printf '%s\n' "┌────────┬───────┬──────┐  ╭─────────────╮  ┏━━━━━━┯━━━━━━┓  ┽┾┿╀╁╂╃╄╅╆╇╈╉╊╋ ┼┼"
printf '%s\n' "│ name   │ value │ unit │  │ rounded box │  ┃ heavy│light ┃  ┞┟┡┢┦┧┩┪┭┮┱┲┵┶┹ ┼┼"
printf '%s\n' "├────────┼───────┼──────┤  │  ╭───────╮  │  ┠──────┼──────┨  ╒╓╕╖╘╙╛╜╞╟╡╢╤╥╧╨╪╫"
printf '%s\n' "│ zoom   │ 1.25  │ ×    │  │  ╰───────╯  │  ┃      │      ┃  ══════════ ║ ╏┇┋ │"
printf '%s\n' "└────────┴───────┴──────┘  ╰─────────────╯  ┗━━━━━━┷━━━━━━┛  ────────── ║ ╏┇┋ │"

# 12: the divider
printf '%s\n' "────────────────────────────────────────────────────────────────────────────────"

# 13-15: braille; eighth blocks, sextants and wedges (Symbols for Legacy Computing); powerline
printf '%s\n' "braille ⠁⠂⠄⡀⠈⠐⠠⢀ ⣀⣠⣤⣴⣶⣾⣿⣿⣷⣶⣦⣤⣄⣀ ⡇⢸⣿⠿⠛⠉ ⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏ eighths 🭰🭱🭲🭳🭴🭵🭶🭷🭸🭹🭺🭻🭼🭽🭾🭿🮀🮁🮂🮃"
printf '%s\n' "sextants 🬀🬁🬂🬃🬄🬅🬆🬇🬈🬉🬊🬋🬌🬍🬎🬏🬐🬑🬒🬓🬔🬕🬖🬗🬘🬙🬚🬛🬜🬝🬞🬟🬠🬡🬢🬣🬤🬥🬦🬧🬨🬩🬪🬫🬬🬭🬮🬯🬰🬱🬲🬳🬴🬵🬶🬷🬸🬹🬺🬻 🮄🮅🮆🮇🮈🮉🮊🮋"
printf '%s\n' "wedges 🬼🬽🬾🬿🭀🭁🭂🭃🭄🭅🭆🭇🭈🭉🭊🭋🭌🭍🭎🭏🭐🭑🭒🭓🭔🭕🭖🭗🭘🭙🭚🭛🭜🭝🭞🭟🭠🭡🭢🭣🭤🭥🭦🭧🭨🭩🭪🭫🭬🭭🭮🭯 ${e}[48;5;31;38;5;231m main ${e}[48;5;240;38;5;31m${P0}${e}[38;5;252m src ${e}[49;38;5;240m${P0}${r} ${e}[38;5;240m${P2}${e}[48;5;240;38;5;252m ok ${r}"

# 16: powerline, the rest (rounded, slanted, thin); a wide emoji on a coloured background
printf '%s\n' "${e}[38;5;31m${P6}${e}[48;5;31;38;5;231m rounded ${e}[49;38;5;31m${P4}${r} ${e}[38;5;166m${PA}${e}[48;5;166;38;5;231m slant ${e}[49;38;5;166m${P8}${r} ${e}[38;5;71m${PE}${e}[48;5;71;38;5;231m back ${e}[49;38;5;71m${PC}${r} ${P1} ${P3} ${P5} ${P7} ${P9} ${PB} ${PD} ${PF} ${e}[48;5;24m 😀 emoji 🚀 fill 🎉 ${r} ${e}[44m😀${e}[45m🚀${e}[46m🎉${r}"

# 17: every style, alone
printf '%s\n' "plain ${e}[1mbold${r} ${e}[2mdim${r} ${e}[3mitalic${r} ${e}[4munderline${r} ${e}[4:2mdouble${r} ${e}[4:3mcurly${r} ${e}[4:4mdotted${r} ${e}[4:5mdashed${r} ${e}[9mstrike${r} ${e}[53moverline${r}"
# 18-19: inverse, conceal, and the styles combined
printf '%s\n' "${e}[7minverse${r} [${e}[8mconcealed${r}] ${e}[1;3mbold italic${r} ${e}[3;4mitalic underline${r} ${e}[4:3;58:2::255:80:80mcurly red${r} ${e}[4:3;58:2::240:200:60mcurly yellow${r} ${e}[2;3mdim it${r}"
printf '%s\n' "${e}[4;58;5;39mblue underline${r} ${e}[9;53mstrike over${r} ${e}[1;4:3;58:2::255:80:80;38;5;221mbold curly${r} ${e}[4:2;9mdouble+strike${r} ${e}[7;1minverse bold${r} ${e}[7;38;5;209minverse colour${r}"
# 20: inverse and dim on colours and fills
printf '%s\n' "${e}[7;4minverse underline${r} ${e}[2;7mdim inverse${r} ${e}[38;5;114mgreen${r} ${e}[2;38;5;114mdim green${r} ${e}[48;5;52m red fill ${e}[2mdim on fill${r} ${e}[2;9mdim strike${r}"
# 21: lines run unbroken across cells, gaps and colour changes
printf '%s\n' "${e}[4munderline across   gaps and ${e}[38;5;114mcolours${e}[38;5;203m joined${r}  ${e}[4:3;58:2::255:80:80mcurly  under  spaces${r}  ${e}[9mstrike  thru${r}"

# 22: plain text for comparison
printf '%s\n' "The quick brown fox jumps over the lazy dog 0123456789 {}[]()<>|/\\ il1I O0o"
exit 0
