#!/bin/bash
# Executable of Efesto.app (built by "Installa app Efesto.command"): starts the local server, which saves projects
# in progetti/, unless it is already running, then opens the editor in the default browser.
APP_RES="$(cd "$(dirname "$0")/../Resources" && pwd)"
DIR="$(cat "$APP_RES/efesto-dir")"
PORT=8765
URL="http://127.0.0.1:$PORT/"
LOG="$HOME/Library/Logs/Efesto.log"
# Apps started from the Dock get a minimal PATH: add the usual places python3 is installed.
export PATH="/opt/homebrew/bin:/usr/local/bin:/Library/Frameworks/Python.framework/Versions/Current/bin:$PATH"

alert() { osascript -e "display alert \"Efesto\" message \"$1\" as critical" >/dev/null; exit 1; }
running() { [ "$(curl -s -o /dev/null -w '%{http_code}' "${URL}api/projects")" = 200 ]; }

if ! running; then
  [ -f "$DIR/server.py" ] || alert "Cartella di Efesto non trovata: $DIR. Se l'hai spostata, esegui di nuovo \"Installa app Efesto\"."
  python3 -c '' 2>/dev/null || alert "Serve Python 3. Installalo da https://www.python.org/downloads/ e riprova."
  lsof -iTCP:$PORT -sTCP:LISTEN >/dev/null 2>&1 && alert "La porta $PORT è occupata da un altro programma."
  cd "$DIR" && nohup python3 server.py $PORT >> "$LOG" 2>&1 &
  for _ in $(seq 50); do running && break; sleep 0.2; done
  running || alert "Il server non è partito. Dettagli in $LOG"
fi
open "$URL"
