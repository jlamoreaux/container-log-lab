#!/usr/bin/env bash
set -euo pipefail
: "${REQUEST_ID:?The parent request must supply REQUEST_ID}"

# These markers go to stderr, so redirecting a command's stdout to a file
# does not hide them. The Node parent turns them into structured container logs.
run_step() {
  local name="$1" status
  shift
  printf 'START\t%s\n' "$name" >&2
  if "$@"; then
    printf 'DONE\t%s\n' "$name" >&2
  else
    status=$?
    printf 'FAILED\t%s\t%s\n' "$name" "$status" >&2
    return "$status"
  fi
}

# Mock Square-like commands; swap these functions for real CLI invocations.
sample_locations() { sleep 0.2; printf '%s\n' '[{"id":"loc-1","name":"Demo shop"}]'; }
sample_counts() { sleep 0.3; printf '%s\n' '[{"item":"item-1","quantity":12}]'; }
sample_catalog() { sleep 0.15; printf '%s\n' '[{"id":"item-1","name":"Notebook"}]'; }
sample_purchase_orders() { sleep 0.25; printf '%s\n' '[{"id":"po-1","status":"OPEN"}]'; }
inspect_files() {
  test -s "$work_dir/locations.json" && test -s "$work_dir/counts.json" &&
    test -s "$work_dir/catalog.json" && test -s "$work_dir/purchase_orders.json"
}

work_dir=$(mktemp -d)
trap 'rm -rf "$work_dir"' EXIT
run_step locations sample_locations > "$work_dir/locations.json"
run_step counts sample_counts > "$work_dir/counts.json"
run_step catalog sample_catalog > "$work_dir/catalog.json"
run_step purchase_orders sample_purchase_orders > "$work_dir/purchase_orders.json"
run_step inspect inspect_files
