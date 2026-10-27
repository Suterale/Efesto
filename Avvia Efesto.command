#!/bin/bash
# Doppio clic per avviare Efesto: avvia il server locale (che salva i progetti in progetti/) e apre il browser.
cd "$(dirname "$0")" || exit 1
PORT=8765
if lsof -iTCP:$PORT -sTCP:LISTEN >/dev/null 2>&1 &&
   [ "$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:$PORT/api/projects)" != 200 ]; then
  # Una versione vecchia (python3 -m http.server, che non sa salvare) occupa la porta: la fermiamo.
  for pid in $(lsof -tiTCP:$PORT -sTCP:LISTEN); do
    ps -o command= -p "$pid" | grep -q "http.server" && kill "$pid"
  done
  sleep 1
fi
if ! lsof -iTCP:$PORT -sTCP:LISTEN >/dev/null 2>&1; then
  python3 server.py $PORT >/dev/null 2>&1 &
  sleep 1
fi
open "http://127.0.0.1:$PORT/"
echo "Efesto in esecuzione su http://127.0.0.1:$PORT/  (progetti salvati in $(pwd)/progetti — chiudi questa finestra per fermarlo)"
wait
