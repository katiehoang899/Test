#!/bin/bash
# Bấm đúp file này (macOS) để chạy Phòng trọ Map và mở trình duyệt.
cd "$(dirname "$0")" || exit 1
PORT="${PORT:-3100}"
URL="http://localhost:$PORT"
OPEN="$(command -v open || command -v xdg-open)"

pause_exit() {
  read -n 1 -s -r -p "Bấm phím bất kỳ để đóng cửa sổ…"
  echo
  exit "$1"
}

if ! command -v node >/dev/null 2>&1; then
  echo "Máy chưa cài Node.js."
  echo "Tải bản LTS tại https://nodejs.org, cài xong rồi bấm đúp lại file này."
  [ -n "$OPEN" ] && "$OPEN" "https://nodejs.org/" >/dev/null 2>&1
  pause_exit 1
fi

MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$MAJOR" -lt 18 ]; then
  echo "Node.js $(node -v) quá cũ, cần bản 18 trở lên. Tải bản mới tại https://nodejs.org"
  pause_exit 1
fi

# Đã chạy rồi thì chỉ mở trình duyệt.
if curl -fs "$URL/api/saved" >/dev/null 2>&1; then
  echo "Phòng trọ Map đang chạy sẵn, mở $URL"
  [ -n "$OPEN" ] && "$OPEN" "$URL"
  exit 0
fi

# Mở trình duyệt khi server sẵn sàng.
(
  for _ in $(seq 1 50); do
    sleep 0.2
    if curl -fs "$URL/api/saved" >/dev/null 2>&1; then
      [ -n "$OPEN" ] && "$OPEN" "$URL"
      break
    fi
  done
) &

PORT="$PORT" node server.js || pause_exit 1
