# Documentation Index

## Features
Current implementation docs for each major feature.

| Doc | Description |
|-----|-------------|
| [Auto-Trader Execution Paths](./features/auto-trader-execution-paths.md) | Three trade sources (Scanner, Influencer, Suggested Finds) — gate logic, FA checks, position sizing |
| [Trade Scanner](./features/trade-scanner.md) | Two-pass day/swing scanner — InPlayScore, Gemini AI, pre-market gaps |
| [Trading Signals Indicators](./features/trading-signals-indicators.md) | Indicator engine — RSI, MACD, EMA, ATR, ADX fed to AI prompts |
| [Suggested Finds](./features/suggested-finds.md) | Daily stock discovery — Quiet Compounders + Gold Mines pipeline |
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
