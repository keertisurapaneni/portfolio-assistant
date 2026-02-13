#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
AUTO_TRADER_DIR="$SCRIPT_DIR"
IBC_DIR="$HOME/ibc"
IBC_CONFIG="$IBC_DIR/config.ini"
IBC_CONFIG_EXAMPLE="$AUTO_TRADER_DIR/ibc/config.ini.example"
LAUNCH_AGENT_LABEL="com.portfolio-assistant.auto-trader"
LAUNCH_AGENT_PATH="$HOME/Library/LaunchAgents/${LAUNCH_AGENT_LABEL}.plist"
PORT_APP="3001"
PORT_IB="4002"

log() {
  printf "[setup] %s\n" "$1"
}

warn() {
  printf "[setup][warn] %s\n" "$1" >&2
}

fail() {
  printf "[setup][error] %s\n" "$1" >&2
  exit 1
}

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || fail "Missing required command: $1"
}

update_ini_key() {
  local key="$1"
  local value="$2"
  local file="$3"

  if grep -q "^${key}=" "$file"; then
    perl -i -pe "s/^${key}=.*/${key}=${value}/" "$file"
  else
    printf "%s=%s\n" "$key" "$value" >> "$file"
  fi
}

check_port() {
  local port="$1"
  lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1
}

write_launch_agent() {
  local node_path
  node_path="$(dirname "$(command -v node)")"

  cat > "$LAUNCH_AGENT_PATH" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LAUNCH_AGENT_LABEL}</string>

  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>-lc</string>
    <string>./start.sh</string>
  </array>

  <key>WorkingDirectory</key>
  <string>${AUTO_TRADER_DIR}</string>

  <key>RunAtLoad</key>
  <true/>

  <key>KeepAlive</key>
  <false/>

  <key>EnvironmentVariables</key>
  <dict>
    <key>HOME</key>
    <string>${HOME}</string>
    <key>PATH</key>
    <string>${node_path}:/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
  </dict>

  <key>StandardOutPath</key>
  <string>/tmp/auto-trader-stdout.log</string>

  <key>StandardErrorPath</key>
  <string>/tmp/auto-trader-stderr.log</string>
</dict>
</plist>
PLIST

  plutil -lint "$LAUNCH_AGENT_PATH" >/dev/null
}

log "Validating prerequisites"
require_cmd bash
require_cmd npm
require_cmd node
require_cmd launchctl
require_cmd lsof
require_cmd curl
require_cmd perl

if [[ "$(uname -s)" != "Darwin" ]]; then
  fail "This setup script currently supports macOS only."
fi

[[ -x "$AUTO_TRADER_DIR/start.sh" ]] || fail "Missing executable start.sh at $AUTO_TRADER_DIR/start.sh"
[[ -f "$IBC_CONFIG_EXAMPLE" ]] || fail "Missing IBC template: $IBC_CONFIG_EXAMPLE"
[[ -x "$IBC_DIR/gatewaystartmacos.sh" ]] || fail "Missing IBC launcher: $IBC_DIR/gatewaystartmacos.sh"

if [[ ! -f "$IBC_CONFIG" ]]; then
  log "Creating $IBC_CONFIG from template"
  cp "$IBC_CONFIG_EXAMPLE" "$IBC_CONFIG"
fi

existing_user="$(awk -F= '/^IbLoginId=/{print $2}' "$IBC_CONFIG" | tail -n1)"
existing_pass="$(awk -F= '/^IbPassword=/{print $2}' "$IBC_CONFIG" | tail -n1)"

if [[ -z "${existing_user:-}" || "$existing_user" == "YOUR_PAPER_USERNAME" ]]; then
  read -r -p "Enter IB paper username (IbLoginId): " ib_user
else
  read -r -p "Enter IB paper username (press Enter to keep '${existing_user}'): " ib_user
  ib_user="${ib_user:-$existing_user}"
fi

if [[ -z "${existing_pass:-}" || "$existing_pass" == "YOUR_PAPER_PASSWORD" ]]; then
  read -r -s -p "Enter IB paper password (IbPassword): " ib_pass
  printf "\n"
else
  read -r -s -p "Enter IB paper password (press Enter to keep current): " ib_pass
  printf "\n"
  ib_pass="${ib_pass:-$existing_pass}"
fi

[[ -n "${ib_user:-}" ]] || fail "IbLoginId cannot be empty"
[[ -n "${ib_pass:-}" ]] || fail "IbPassword cannot be empty"

update_ini_key "IbLoginId" "$ib_user" "$IBC_CONFIG"
update_ini_key "IbPassword" "$ib_pass" "$IBC_CONFIG"
update_ini_key "TradingMode" "paper" "$IBC_CONFIG"

log "Installing Node dependencies and building"
cd "$AUTO_TRADER_DIR"
npm install
npm run build

log "Writing LaunchAgent plist"
mkdir -p "$HOME/Library/LaunchAgents"
write_launch_agent

uid="$(id -u)"
log "Reloading LaunchAgent (${LAUNCH_AGENT_LABEL})"
launchctl bootout "gui/$uid" "$LAUNCH_AGENT_PATH" >/dev/null 2>&1 || true
launchctl bootstrap "gui/$uid" "$LAUNCH_AGENT_PATH"
launchctl enable "gui/$uid/${LAUNCH_AGENT_LABEL}"
launchctl kickstart -k "gui/$uid/${LAUNCH_AGENT_LABEL}"

log "Waiting for services to initialize"
sleep 40

app_ok="no"
ib_ok="no"
health_ok="no"
status_ok="no"

if check_port "$PORT_APP"; then app_ok="yes"; fi
if check_port "$PORT_IB"; then ib_ok="yes"; fi
if curl -fsS "http://localhost:${PORT_APP}/health" >/dev/null 2>&1; then health_ok="yes"; fi
if curl -fsS "http://localhost:${PORT_APP}/api/status" >/dev/null 2>&1; then status_ok="yes"; fi

printf "\n"
log "Setup complete"
printf "- App port %s listening: %s\n" "$PORT_APP" "$app_ok"
printf "- IB port %s listening: %s\n" "$PORT_IB" "$ib_ok"
printf "- /health reachable: %s\n" "$health_ok"
printf "- /api/status reachable: %s\n" "$status_ok"
printf "\n"
printf "Next: open https://portfolioassistant.org/paper-trading, sign in, and click Enable Auto-Trading.\n"
printf "Logs: /tmp/auto-trader-stdout.log, /tmp/auto-trader-stderr.log, ~/ibc/logs/\n"
