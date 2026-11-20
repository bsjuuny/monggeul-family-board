#!/data/data/com.termux/files/usr/bin/sh
# Termux:Boot 자동 시작 스크립트.
# 설치: Termux:Boot 앱(F-Droid)을 설치·한 번 실행한 뒤
#   mkdir -p ~/.termux/boot && cp scripts/termux-boot.sh ~/.termux/boot/monggeul-board && chmod +x ~/.termux/boot/monggeul-board
# 태블릿이 재부팅되면 화면을 켜 두는 wake lock 을 잡고 서버를 띄운다. 서버가 죽으면 10초 뒤 다시 띄운다.
termux-wake-lock
cd "$HOME/monggeul-family-board" || exit 1
mkdir -p "$HOME/monggeul-family-board-data/logs"
LOG="$HOME/monggeul-family-board-data/logs/server.log"
while true; do
  # 5MB 넘으면 한 번 돌려 둔다(server.log.1)
  if [ -f "$LOG" ] && [ "$(wc -c < "$LOG")" -gt 5000000 ]; then mv "$LOG" "$LOG.1"; fi
  python tablet_server/app.py --host 0.0.0.0 --port 8787 >> "$LOG" 2>&1
  echo "$(date '+%F %T') 서버 종료(코드 $?) - 10초 뒤 다시 시작" >> "$LOG"
  sleep 10
done
