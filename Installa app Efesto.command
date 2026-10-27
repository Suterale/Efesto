#!/bin/bash
# Doppio clic per creare Efesto.app in ~/Applications: un'app con icona che avvia Efesto da questa cartella.
# Se sposti la cartella, eseguilo di nuovo.
cd "$(dirname "$0")" || exit 1
DIR="$(pwd)"
APP="$HOME/Applications/Efesto.app"

rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cat > "$APP/Contents/Info.plist" <<'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>Efesto</string>
  <key>CFBundleDisplayName</key><string>Efesto</string>
  <key>CFBundleIdentifier</key><string>io.github.suterale.efesto.launcher</string>
  <key>CFBundleExecutable</key><string>Efesto</string>
  <key>CFBundleIconFile</key><string>Efesto</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>1.0</string>
  <key>LSMinimumSystemVersion</key><string>11.0</string>
  <key>NSDesktopFolderUsageDescription</key><string>Efesto salva e apre i progetti nella sua cartella.</string>
  <key>NSDocumentsFolderUsageDescription</key><string>Efesto salva e apre i progetti nella sua cartella.</string>
  <key>NSDownloadsFolderUsageDescription</key><string>Efesto salva e apre i progetti nella sua cartella.</string>
  <key>NSRemovableVolumesUsageDescription</key><string>Efesto salva e apre i progetti nella sua cartella.</string>
  <key>NSNetworkVolumesUsageDescription</key><string>Efesto salva e apre i progetti nella sua cartella.</string>
</dict>
</plist>
EOF
# cat rather than cp, so the app does not inherit the quarantine flag of a downloaded zip.
cat mac/launcher.sh > "$APP/Contents/MacOS/Efesto"
cat mac/Efesto.icns > "$APP/Contents/Resources/Efesto.icns"
printf '%s' "$DIR" > "$APP/Contents/Resources/efesto-dir"
chmod +x "$APP/Contents/MacOS/Efesto"
xattr -cr "$APP" 2>/dev/null
# Ad-hoc signature: macOS remembers the permission to read the Desktop/Documents folder only for a signed app.
codesign --force --sign - "$APP" 2>/dev/null
touch "$APP"
/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -f "$APP" 2>/dev/null

echo "Creata $APP (avvia Efesto da $DIR)"

if ! defaults read com.apple.dock persistent-apps 2>/dev/null | grep -q "Applications/Efesto.app"; then
  answer=$(osascript -e 'button returned of (display dialog "Efesto.app è pronta in Applicazioni. Vuoi aggiungerla al Dock?" with title "Efesto" buttons {"No", "Aggiungi al Dock"} default button 2)' 2>/dev/null)
  if [ "$answer" = "Aggiungi al Dock" ]; then
    defaults write com.apple.dock persistent-apps -array-add "<dict><key>tile-data</key><dict><key>file-data</key><dict><key>_CFURLString</key><string>file://$APP/</string><key>_CFURLStringType</key><integer>15</integer></dict></dict></dict>"
    killall Dock
    echo "Aggiunta al Dock."
  fi
fi
open -R "$APP"
