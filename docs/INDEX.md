# Documentation Index

## Features
Current implementation docs for each major feature.

| Doc | Description |
|-----|-------------|
| [Options Wheel Engine](./features/options-wheel-engine.md) | Complete reference: VIX-tiered delta, 200 DMA entry, full-day scan schedule, rolling logic, CC cost-basis guard |
| [Morning Brief](./features/morning-brief.md) | AI pre-market research dashboard — architecture, cloud schedule, data schema, on-demand generation |
| [Auto-Trader Execution Paths](./features/auto-trader-execution-paths.md) | Three trade sources (Scanner, Influencer, Suggested Finds) — gate logic, FA checks, position sizing |
| [Trade Scanner](./features/trade-scanner.md) | Two-pass day/swing scanner — InPlayScore, Gemini AI, pre-market gaps |
| [SPX Level Scanner](./features/spx-level-scanner.md) | Mechanical breakout-retest scanner — Somesh's $50 SPX key-level strategy, trades SPY |
| [ORB Chop Filter](./features/orb-chop-filter.md) | Opening Range Breakout gate — skips day trades when price is inside the 15-min opening range |
| [VWAP Alignment](./features/vwap-alignment.md) | VWAP confidence modifier for day trades — +0.3 when price is near the institutional average, after 10 AM only |
| [Trading Signals Indicators](./features/trading-signals-indicators.md) | Indicator engine — RSI, MACD, EMA, ATR, ADX fed to AI prompts |
| [Suggested Finds](./features/suggested-finds.md) | Daily stock discovery — Quiet Compounders + Gold Mines pipeline |
| [Gold Mines](./features/gold-mines.md) | Gold Mine archetype rules — exit logic, sizing, empirical evidence, simulation |
| [Steady Compounders](./features/steady-compounders.md) | Compounder rules — macro circuit breaker, thesis gate, entry cap, health check, profit trim |
| [Strategy Video Ingestion](./features/strategy-video-ingestion.md) | YouTube/Instagram strategy import → external signals flow |
| [Strategy Video Architecture](./features/strategy-video-architecture.md) | Architecture for ingesting trading strategies from videos |
| [AI Buy Priority System](./features/ai-buy-priority.md) | Conviction scoring rules (Quality, Earnings, Analyst, Momentum) |
| [Broker Integration](./features/broker-integration.md) | SnapTrade + IB authentication and trade execution |
| [Long-Term Outlook](./features/long-term-outlook.md) | Fundamentals analysis via Finnhub + Gemini |
| [Compounders Categories](./features/compounders-categories.md) | Category framework for Quiet Compounders discovery |

## Prompts
AI prompt sequences used in the analysis pipeline.

| Doc | Description |
|-----|-------------|
| [Day Trade Prompts](./prompts/day-trade.md) | Pass 1 + Pass 2 prompt flow for day trade analysis |
| [Swing Trade Prompts](./prompts/swing-trade.md) | Pass 1 + Pass 2 prompt flow for swing trade analysis |

## Queries
SQL queries for validating and debugging trade data.

| Doc | Description |
|-----|-------------|
| [Day Trade Validation](./queries/day-trade-validation.md) | Queries for day trade funnel diagnostics |
| [Swing Trade Validation](./queries/swing-trade-validation.md) | Queries for swing trade funnel diagnostics |
| [Suggested Finds DB](./queries/suggested-finds-db.md) | Schema and queries for daily_suggestions table |

## Guides
Operational how-tos and deployment references.

| Doc | Description |
|-----|-------------|
| [Somesh's Trading Strategies](./guides/somesh-strategies.md) | Complete reference: SPX key levels, ORB filter, VWAP anchor, confluence — how all four stack |
| [Daily Trading Routine](./guides/daily-trading-routine.md) | Morning checklist, schedule, signal pipeline, troubleshooting |
| [Deploy Market Movers](./guides/deploy-market-movers.md) | Market movers scraper deployment |
| [Deploy Yahoo News](./guides/deploy-yahoo-news.md) | Yahoo Finance news integration setup |
| [Trade Performance Logging](./guides/trade-performance-logging.md) | P&L and metrics tracking schema |
| [Vulnerability Scanning](./guides/vulnerability-scanning.md) | Security scanning procedures |

## Other
| Doc | Description |
|-----|-------------|
| [Supabase Setup](../supabase/README.md) | Supabase project setup, migrations, credentials |
| [Edge Functions](../supabase/functions/README.md) | Edge function architecture and shared modules |
| [Architecture Decisions](../_bmad-output/planning-artifacts/architecture/core-architectural-decisions.md) | Major architectural choices and rationale |
| [Implementation Patterns](../_bmad-output/planning-artifacts/architecture/implementation-patterns-consistency-rules.md) | Code standards and consistency rules |
| [Integration Points](../_bmad-output/planning-artifacts/architecture/integration-points-api-contracts.md) | External API contracts (Finnhub, Yahoo, Gemini, IB) |

## Session Notes (Cursor)
Design sessions and multi-step implementation plans.

| Doc | Description |
|-----|-------------|
| [Options Wheel Engine — Design (2026-04-20)](./cursor/2026-04-20-options-wheel-engine.md) | Initial brainstorming, signal library (46 ideas), decision tree, UI spec |
| [Options Wheel Strategy Upgrades (2026-04-21)](./cursor/2026-04-21-options-wheel-strategy-upgrades.md) | Video-analysis-driven upgrades: prob-profit floor, break-even display, ROC, stop-loss, auto-roll, 21 DTE hard close |
| [Advanced Options + Morning Brief (2026-04-24)](./cursor/2026-04-24-advanced-options-morning-brief.md) | VIX-tiered delta, 200 DMA gate, rolling strategy, CC cost-basis guard, morning brief, full-day scanning |
| [Trade Scanner — Key Levels (2026-04-20)](./cursor/2026-04-20-trade-scanner-track1-key-levels.md) | Track 1 key levels enhancement design |
| [SPX Breakout-Retest Strategy (2026-04-27)](./cursor/2026-04-27-spx-breakout-retest-strategy.md) | Somesh's $50 key-level strategy — design decisions and trade-offs |

## Archive
Historical planning artifacts and session notes — kept for reference, superseded by implementation.

| Doc | Description |
|-----|-------------|
| [Self-Learning Trading System](./archive/self-learning-trading-system.md) | Auto-tune and EV-weighted strategy design |
| [Unified Analysis Pipeline](./archive/unified-analysis-pipeline.md) | Early pipeline design |
| [Ingest Pipeline Lessons](./archive/ingest-pipeline-lessons-learned.md) | Video ingest retrospective |
| [Trading Signals PRD](./archive/prd-trading-signals.md) | Original trading signals product requirements |
| [Trading Signals Spec](./archive/technical-spec-trading-signals.md) | Original technical specification |
| [Trade Signals V2](./archive/trade-signals-v2.md) | V2 enhancement proposals |
| [Per-Stock AI Refactor](./archive/per-stock-ai-refactor.md) | Refactoring design notes |
| [Worklog Feb 19](./archive/worklog-2026-02-19.md) | Dev session notes |
