#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
SKILL_DIR="$(cd -- "${SCRIPT_DIR}/.." && pwd)"
VENV_DIR="${SKILL_DIR}/.venv"
VENV_PYTHON="${VENV_DIR}/bin/python"

if ! command -v uv >/dev/null 2>&1; then
  echo "uv is required to bootstrap the extractor environment." >&2
  exit 1
fi

if [ ! -x "${VENV_PYTHON}" ]; then
  uv venv "${VENV_DIR}"
fi

uv pip install --python "${VENV_PYTHON}" -r "${SCRIPT_DIR}/requirements.txt"

exec "${VENV_PYTHON}" "${SCRIPT_DIR}/extract.py" "$@"
