#!/usr/bin/env sh
# 中文注释：本地一键质量门禁，与 CI 同款：ruff + pytest + 前端预览安全单测 + tsc + vite build。
# 用法: sh scripts/check.sh
set -eu
cd "$(dirname "$0")/.."

echo "== ruff =="
python -m ruff check app tests

echo "== pytest =="
python -m pytest -q

echo "== preview safety tests (node --test) =="
cd frontend
node --test --experimental-strip-types tests/preview-safety.test.ts

echo "== tsc --noEmit =="
npx tsc --noEmit

echo "== vite build =="
npm run build

echo "全部检查通过。"
