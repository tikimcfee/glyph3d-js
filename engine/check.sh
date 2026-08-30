#!/usr/bin/env bash
# check.sh — run every engine suite with the flags the contract requires.
#
# WHY THIS SCRIPT EXISTS: --fp-mode contract=off is not optional.
#
# Mojo 1.0 defaults to `contract=fast`, which is Clang's -ffp-contract=fast: it
# fuses `a + b*c` into an FMA ACROSS STATEMENTS. Splitting the expression into
# `var t = a*b` and then `t + c` still contracts. Verified in emitted assembly —
# a kernel doing o[i] = a[i]*b[i] + c[i] emits 2 fmla under the default and 2 fmul
# under contract=off.
#
# This pipeline is bit-exact against a JS oracle, and JS rounds at every step while
# an FMA rounds once. The port is full of `a*b + c` shapes:
#     Float32(-Float64(row) * lh + oy)
#     Float32(-Float64(wrap_row) * z_step + oz)
#     paginate's four-term M_Z chain
#
# Today the f64 intermediates truncate to f32 and the difference vanishes, so the
# suites pass either way. That is LUCK, not a guarantee — a future f64 lane, a
# reassociated expression, or a compiler version bump could turn it into silent
# oracle divergence. Pinning the flag costs nothing measurable (bench checksums and
# throughput identical) and converts luck into a property.
#
# Usage:  engine/check.sh          run every suite
#         engine/check.sh gpu      GPU suites only
set -euo pipefail
cd "$(dirname "$0")/.."
export PATH="$PWD/.venv-mojo/bin:$PATH"

FP="--fp-mode contract=off"
PIPE=(engine/fixtures/*.pipe.bin)
BAKE=(engine/fixtures/*.bake.bin)

CPU=(conformance conformance_scan ordinal_invariant conformance_record conformance_resume)
# gaps takes ONE fixture and builds its own item topologies
GAPS=engine/fixtures/repo-file.pipe.bin
GPU=(gpu_decode gpu_scan gpu_paginate gpu_bounds gpu_pipeline)

run() { # name, fixtures...
    local name=$1; shift
    printf '%-22s ' "$name"
    if out=$(mojo run $FP -I engine "engine/$name.mojo" "$@" 2>&1); then
        echo "${out##*$'\n'}"
    else
        echo "FAILED"; echo "$out" | tail -5; exit 1
    fi
}

case "${1:-all}" in
    gpu) list=("${GPU[@]}") ;;
    cpu) list=("${CPU[@]}") ;;
    *)   list=("${CPU[@]}" "${GPU[@]}") ;;
esac

for s in "${list[@]}"; do run "$s" "${PIPE[@]}"; done
[[ "${1:-all}" == "gpu" ]] || run conformance_gaps "$GAPS"
[[ "${1:-all}" == "gpu" ]] || run conformance_bake "${BAKE[@]}"
echo "all suites green (fp contraction disabled)"
