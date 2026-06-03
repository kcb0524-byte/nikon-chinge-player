#!/bin/bash
# ================================================
# 니콘 친게 뮤직 플레이어 - DMG 빌드 (배포용)
# ================================================
cd "$(dirname "$0")"

echo "================================================"
echo "  🔨 DMG 배포 파일 빌드"
echo "================================================"
echo ""

# Node.js 확인
if ! command -v node &> /dev/null; then
  osascript -e 'display alert "Node.js가 필요합니다" message "https://nodejs.org 에서 설치 후 다시 실행해주세요." buttons {"확인"} default button 1'
  exit 1
fi

# node_modules 없으면 설치
if [ ! -d "node_modules" ] || [ ! -f "node_modules/.bin/electron" ]; then
  echo "📦 패키지 설치 중..."
  npm install
fi

echo "🏗️  DMG 빌드 중... (수분 소요됩니다)"
echo ""
npx electron-builder --mac dmg

if [ $? -eq 0 ]; then
  echo ""
  echo "✅ DMG 빌드 완료!"
  echo "📁 dist/ 폴더에 DMG 파일이 생성되었습니다."
  open "$(dirname "$0")/dist"
  osascript -e 'display alert "빌드 완료!" message "dist 폴더에 DMG 파일이 생성되었습니다. Finder가 열립니다." buttons {"확인"} default button 1'
else
  echo ""
  echo "❌ 빌드 실패"
  osascript -e 'display alert "빌드 실패" message "오류가 발생했습니다. 터미널 출력 내용을 확인해주세요." buttons {"확인"} default button 1'
fi
