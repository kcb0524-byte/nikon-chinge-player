#!/bin/bash
# ================================================
# 니콘 친게 뮤직 플레이어 - 설치 및 실행 스크립트
# ================================================

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

echo "🎵 니콘 친게 뮤직 플레이어 설치 시작..."
echo ""

# Node.js 확인
if ! command -v node &> /dev/null; then
  echo "❌ Node.js가 설치되어 있지 않습니다."
  echo "   https://nodejs.org 에서 설치해주세요."
  exit 1
fi

echo "✅ Node.js $(node --version) 확인"
echo "✅ npm $(npm --version) 확인"
echo ""

# npm 패키지 설치
echo "📦 패키지 설치 중... (처음에는 수분이 걸릴 수 있습니다)"
npm install
if [ $? -ne 0 ]; then
  echo "❌ 패키지 설치 실패. 네트워크 연결을 확인해주세요."
  exit 1
fi

echo ""
echo "✅ 설치 완료!"
echo ""
echo "🚀 앱을 시작합니다..."
npx electron .
