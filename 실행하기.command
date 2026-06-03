#!/bin/bash
cd "$(dirname "$0")"

echo "================================================"
echo "  🎵 니콘 친게 뮤직 플레이어"
echo "================================================"

if ! command -v node &> /dev/null; then
  osascript -e 'display alert "Node.js가 필요합니다" message "https://nodejs.org 에서 LTS 버전을 설치 후 다시 실행해주세요." buttons {"확인"} default button 1'
  exit 1
fi
echo "✅ Node.js $(node --version)"

echo "📦 패키지 설치 중..."
npm install
if [ $? -ne 0 ]; then
  osascript -e 'display alert "설치 실패" message "npm install에 실패했습니다." buttons {"확인"} default button 1'
  exit 1
fi

echo "🚀 앱 시작..."
exec npx electron .
