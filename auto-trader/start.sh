#!/bin/bash
# ─────────────────────────────────────────────────────────
# Portfolio Assistant — Auto-Trader Launcher
#
# Starts IB Gateway (via IBC) and the auto-trader Node.js service.
# Designed for macOS with IBC installed at ~/ibc/.
#
# Prerequisites:
#   1. IB Gateway installed: ~/Applications/IB Gateway 10.x/
#   2. IBC installed at ~/ibc/ with config.ini configured
#   3. npm install already run in this directory
# ─────────────────────────────────────────────────────────

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

PORT="${PORT:-3001}"

# ── Colors ──
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

echo -e "${GREEN}🚀 Starting Portfolio Assistant Auto-Trader${NC}"
echo ""

# ── Check prerequisites ──

if [ ! -f "$HOME/ibc/config.ini" ]; then
  echo -e "${RED}❌ Missing ~/ibc/config.ini${NC}"
  echo "   Configure IBC with your IB paper trading credentials."
  exit 1
fi

# ── Load nvm if available (needed for launchd which has bare PATH) ──
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"

if [ ! -f "node_modules/.package-lock.json" ]; then
  echo -e "${YELLOW}📦 Installing Node.js dependencies...${NC}"
  npm install
fi

if [ ! -d "dist" ]; then
  echo -e "${YELLOW}🔨 Building auto-trader service...${NC}"
  npm run build
fi

# ── Reclaim service port if a stale process is holding it ──
listener_pids="$(lsof -tiTCP:"$PORT" -sTCP:LISTEN || true)"
if [ -n "$listener_pids" ]; then
  echo -e "${YELLOW}⚠️  Port $PORT is already in use${NC}"

  running_our_service="no"
  while IFS= read -r pid; do
    [ -z "$pid" ] && continue
    cmd="$(ps -p "$pid" -o command= 2>/dev/null || true)"
    if echo "$cmd" | grep -q "/auto-trader/dist/index.js"; then
      running_our_service="yes"
      break
    fi
  done <<< "$listener_pids"

  if [ "$running_our_service" = "yes" ]; then
    echo -e "${GREEN}✅ Auto-trader already running on port $PORT${NC}"
    echo "   No restart needed."
    exit 0
  fi

  echo "   Attempting to stop stale listener(s): $listener_pids"
  echo "$listener_pids" | xargs kill -TERM 2>/dev/null || true

  for _ in 1 2 3 4 5; do
    sleep 1
    if ! lsof -tiTCP:"$PORT" -sTCP:LISTEN > /dev/null 2>&1; then
      break
    fi
  done

  if lsof -tiTCP:"$PORT" -sTCP:LISTEN > /dev/null 2>&1; then
    echo "   Listener still active; forcing stop."
    lsof -tiTCP:"$PORT" -sTCP:LISTEN | xargs kill -KILL 2>/dev/null || true
    sleep 1
  fi

  if lsof -tiTCP:"$PORT" -sTCP:LISTEN > /dev/null 2>&1; then
    echo -e "${RED}❌ Unable to free port $PORT${NC}"
    exit 1
  fi
fi

# ── Start IB Gateway via IBC (macOS) ──

IBC_GATEWAY_SCRIPT="$HOME/ibc/gatewaystartmacos.sh"
IB_GATEWAY_PORT="${IB_GATEWAY_PORT:-4002}"

ib_gateway_running() {
  local pid cmd
  pid="$(lsof -tiTCP:"$IB_GATEWAY_PORT" -sTCP:LISTEN 2>/dev/null | head -n 1)"
  [ -z "$pid" ] && return 1

  cmd="$(ps -p "$pid" -o command= 2>/dev/null || true)"
  echo "$cmd" | grep -qi "java" || return 1
  echo "$cmd" | grep -Eqi "ibgateway|jts|tws" || return 1

  return 0
}

if [ -f "$IBC_GATEWAY_SCRIPT" ]; then
  if ib_gateway_running; then
    echo -e "${GREEN}📡 IB Gateway is already running on port $IB_GATEWAY_PORT${NC}"
  else
    echo -e "${GREEN}📡 Starting IB Gateway via IBC...${NC}"
    # Launch detached so Gateway survives even if this shell exits.
    nohup "$IBC_GATEWAY_SCRIPT" -inline >/tmp/ibc-launch.out.log 2>/tmp/ibc-launch.err.log &
    IBC_PID=$!
    echo -e "   IBC PID: $IBC_PID"

    # Wait for Gateway to initialize
    echo -e "${YELLOW}⏳ Waiting 30s for IB Gateway to start...${NC}"
    sleep 30

    if ib_gateway_running; then
      echo -e "${GREEN}✅ IB Gateway is listening on port $IB_GATEWAY_PORT${NC}"
    else
      echo -e "${YELLOW}⚠️  IB Gateway did not appear on port $IB_GATEWAY_PORT yet${NC}"
      echo "   Check /tmp/ibc-launch.err.log and ~/ibc/logs/* for login issues."
    fi
  fi
else
  echo -e "${YELLOW}⚠️  IBC not found at ~/ibc/gatewaystartmacos.sh${NC}"
  echo "   Start IB Gateway manually. The auto-trader will auto-connect when ready."
  echo ""
fi

# ── Start auto-trader Node.js service ──

echo -e "${GREEN}🤖 Starting auto-trader service on port $PORT...${NC}"
echo ""

# Load environment
if [ -f ".env" ]; then
  set -a
  source .env
  set +a
fi

# Graceful shutdown
cleanup() {
  echo -e "\n${YELLOW}Shutting down...${NC}"
  exit 0
}
trap cleanup SIGINT SIGTERM

# Start the service (foreground — Ctrl+C to stop)
exec npm start
