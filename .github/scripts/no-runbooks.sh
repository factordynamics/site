#!/usr/bin/env bash
# This repository is public. Operator runbooks and machine setup (recovery steps, secret and access procedures, host
# layout) stay on the machine that runs the API, never here. Fails when any such file exists anywhere in the tree,
# not only when one is added.
set -euo pipefail
bad=$(git ls-files | grep -iE '(^|/)(ops|selfhost)/|(^|/)[^/]*(steps|runbook|restore)[^/]*\.(md|txt)$|(^|/)[^/]*\.env\.example$' || true)
if [ -n "$bad" ]; then
  echo "::error::Operator files must not be in this public repository (keep them on the API host):"
  echo "$bad"
  exit 1
fi
echo "no operator runbooks or host setup in the tree"
