#!/bin/bash
# ─────────────────────────────────────────────────────────
# Portfolio Assistant — Auto-Trader Launcher
#
# Starts IB Gateway (via IBC) and the auto-trader Node.js service.
# Run this once each morning, or configure launchd for auto-start.
#
# Prerequisites:
#   1. IB Gateway installed: https://www.interactivebrokers.com/en/trading/ibgateway-stable.php
#   2. IBC installed: https://github.com/IbcAlpha/IBC/releases
#   3. ibc/config.ini configured with paper trading credentials
#   4. npm install already run in this directory
# ─────────────────────────────────────────────────────────

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

# ── Colors ──
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

echo -e "${GREEN}🚀 Starting Portfolio Assistant Auto-Trader${NC}"
echo ""

# ── Check prerequisites ──

if [ ! -f "ibc/config.ini" ]; then
  echo -e "${RED}❌ Missing ibc/config.ini${NC}"
  echo "   Copy ibc/config.ini.example → ibc/config.ini and add your IB credentials."
  exit 1
fi

if [ ! -f "node_modules/.package-lock.json" ]; then
  echo -e "${YELLOW}📦 Installing Node.js dependencies...${NC}"
  npm install
fi

if [ ! -d "dist" ]; then
  echo -e "${YELLOW}🔨 Building auto-trader service...${NC}"
  npm run build
fi

# ── Locate IBC ──

IBC_PATH=""
if [ -d "$HOME/ibc" ]; then
  IBC_PATH="$HOME/ibc"
elif [ -d "/opt/ibc" ]; then
  IBC_PATH="/opt/ibc"
elif [ -d "$HOME/Applications/IBC" ]; then
  IBC_PATH="$HOME/Applications/IBC"
fi

# ── Start IB Gateway via IBC ──

if [ -n "$IBC_PATH" ]; then
  echo -e "${GREEN}📡 Starting IB Gateway via IBC...${NC}"
  echo "   IBC path: $IBC_PATH"

  # Find the start script
  START_SCRIPT=""
  if [ -f "$IBC_PATH/scripts/ibcstart.sh" ]; then
    START_SCRIPT="$IBC_PATH/scripts/ibcstart.sh"
  elif [ -f "$IBC_PATH/StartGateway.sh" ]; then
    START_SCRIPT="$IBC_PATH/StartGateway.sh"
  elif [ -f "$IBC_PATH/scripts/StartGateway.sh" ]; then
    START_SCRIPT="$IBC_PATH/scripts/StartGateway.sh"
  fi

  if [ -n "$START_SCRIPT" ]; then
    # Start IB Gateway in background with IBC config
    "$START_SCRIPT" \
      --gateway \
      --mode=paper \
      --config="$SCRIPT_DIR/ibc/config.ini" \
      &
    IBC_PID=$!
    echo -e "   IBC PID: $IBC_PID"

    # Wait for Gateway to initialize
    echo -e "${YELLOW}⏳ Waiting 30s for IB Gateway to start...${NC}"
    sleep 30
  else
    echo -e "${YELLOW}⚠️  IBC found at $IBC_PATH but no start script detected.${NC}"
    echo "   Start IB Gateway manually, then this service will auto-connect."
  fi
else
  echo -e "${YELLOW}⚠️  IBC not found at ~/ibc, /opt/ibc, or ~/Applications/IBC${NC}"
  echo "   Start IB Gateway manually. The auto-trader will auto-connect when ready."
  echo ""
  echo "   To install IBC:"
  echo "   1. Download from https://github.com/IbcAlpha/IBC/releases"
  echo "   2. Extract to ~/ibc/"
  echo "   3. Run this script again"
  echo ""
fi

# ── Start auto-trader Node.js service ──

echo -e "${GREEN}🤖 Starting auto-trader service on port ${PORT:-3001}...${NC}"
echo ""

# Load environment
if [ -f ".env" ]; then
  set -a
  source .env
  set +a
fi

# Start the service (foreground — Ctrl+C to stop both)
exec npm start
