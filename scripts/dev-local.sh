#!/usr/bin/env bash

set -u

web_pid=''
finance_pid=''
stopping=0
status_dir=$(mktemp -d "${TMPDIR:-/tmp}/mym-dev-local.XXXXXX") || exit 1

stop_process_tree() {
  local pid=$1
  local children child
  children=$(pgrep -P "$pid" 2>/dev/null || true)
  for child in $children; do
    stop_process_tree "$child"
  done
  kill "$pid" 2>/dev/null || true
}

stop_children() {
  if [ -n "$web_pid" ]; then
    stop_process_tree "$web_pid"
  fi
  if [ -n "$finance_pid" ]; then
    stop_process_tree "$finance_pid"
  fi
  if [ -n "$web_pid" ]; then
    wait "$web_pid" 2>/dev/null || true
  fi
  if [ -n "$finance_pid" ]; then
    wait "$finance_pid" 2>/dev/null || true
  fi
}

run_web() {
  npm run dev:web
  status=$?
  printf '%s\n' "$status" > "$status_dir/web.status"
  return "$status"
}

run_finance() {
  npm run dev:finance
  status=$?
  printf '%s\n' "$status" > "$status_dir/finance.status"
  return "$status"
}

cleanup() {
  status=$?
  if [ "$stopping" -eq 0 ]; then
    stopping=1
    stop_children
  fi
  rm -rf "$status_dir"
  exit "$status"
}

handle_signal() {
  stopping=1
  stop_children
  rm -rf "$status_dir"
  exit 130
}

trap handle_signal INT TERM
trap cleanup EXIT

(run_web) &
web_pid=$!
(run_finance) &
finance_pid=$!

# Bash 3.2 has no wait -n; poll both children and stop the pair on exit.
while true; do
  if [ -f "$status_dir/web.status" ]; then
    status=$(<"$status_dir/web.status")
    [ "$status" -eq 0 ] && status=1
    stopping=1
    stop_children
    exit "$status"
  fi

  if [ -f "$status_dir/finance.status" ]; then
    status=$(<"$status_dir/finance.status")
    [ "$status" -eq 0 ] && status=1
    stopping=1
    stop_children
    exit "$status"
  fi

  sleep 1
done
