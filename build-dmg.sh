#!/bin/bash
# ================================================
# 니콘 친게 뮤직 플레이어 - DMG 빌드 스크립트
# ================================================

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

echo "🔨 DMG 빌드 시작..."

# node_modules 없으면 설치
if [ ! -d "node_modules" ]; then
  echo "📦 패키지 설치 중..."
  npm install
fi

echo "🏗️  빌드 중... (수분이 걸릴 수 있습니다)"
npx electron-builder --mac

if [ $? -eq 0 ]; then
  echo ""
  echo "✅ 빌드 완료!"
  echo "📁 dist/ 폴더에 DMG 파일이 생성되었습니다."
  open dist/
else
  echo "❌ 빌드 실패"
fi
