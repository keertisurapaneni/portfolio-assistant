# LLM Model Migration — Groq + Gemini deprecations

**Date:** 2026-08-17
**Trigger:** Suggested Finds discovery returned nothing; logs showed `HuggingFace error 400: LLM API error: 400` and morning-brief `All LLM providers exhausted`.

## Root cause

External model deprecations — not a code bug. Verified live against the account's Groq key
(`GET /openai/v1/models`): every chat model the codebase referenced was gone.

| Model in code | Result | Used by |
|---|---|---|
| `llama-3.3-70b-versatile` | 404 model_not_found | discovery (`huggingface-proxy`) |
| `llama-3.1-8b-instant` | 404 model_not_found | discovery fallback |
| `llama3-8b-8192` | 400 model_decommissioned | discovery last-resort |
| `meta-llama/llama-4-scout-17b-16e-instruct` | 404 model_not_found | morning-brief, trade-scanner, feedback |
| `gemini-2.0-flash` | 404 (Google deprecated) | morning-brief, trade-scanner, trading-signals |
| `gemini-1.5-flash` | 404 (Google deprecated) | morning-brief, trade-scanner |

`gemini-2.0-flash-lite` was still alive (trade-scanner succeeded via it).

## Fix — current GA models

Verified working Groq chat models on this account: `openai/gpt-oss-120b` (674ms),
`openai/gpt-oss-20b` (281ms), `qwen/qwen3.6-27b` (1.3s, reasoning — `<think>` stripped).

| File | Change |
|---|---|
| `supabase/functions/huggingface-proxy/index.ts` | `GROQ_MODELS` → `['openai/gpt-oss-120b','openai/gpt-oss-20b','qwen/qwen3.6-27b']` |
| `supabase/functions/generate-morning-brief/index.ts` | `GROQ_MODEL` → `openai/gpt-oss-120b`; Gemini URLs → `gemini-2.5-flash` (primary) + `gemini-2.0-flash-lite` (fallback) |
| `supabase/functions/trade-scanner/index.ts` | `GROQ_MODEL` → `openai/gpt-oss-120b`; `GEMINI_MODELS` → `['gemini-2.5-flash','gemini-2.0-flash-lite']` |
| `supabase/functions/trading-signals/index.ts` | `GEMINI_MODELS` → `['gemini-2.5-flash','gemini-2.0-flash-lite']` |
| `auto-trader/src/lib/feedback.ts` | `GROQ_MODEL` → `openai/gpt-oss-120b` |

## Reasoning models need `reasoning_effort: 'low'`

After the model swap, discovery returned `502 Empty response from LLM`. Cause: gpt-oss /
qwen are **reasoning models** — hidden reasoning tokens count against `max_tokens`. Step 1
(`discovery.ts`) passes `maxOutputTokens=1000`; reasoning consumed 827/871 tokens, leaving
empty/near-empty content. Fix: `huggingface-proxy` now sends `reasoning_effort: 'low'`
(reasoning → ~15 tokens, content always fits, ~8x faster). Verified against gpt-oss-120b.

Any future edge function that adopts a Groq reasoning model must set `reasoning_effort: 'low'`
(or a large enough `max_tokens`) or it will intermittently return empty content.

## Deploy

Edge functions must be redeployed (code lives server-side):

```
npx supabase functions deploy huggingface-proxy --no-verify-jwt
npx supabase functions deploy generate-morning-brief --no-verify-jwt
npx supabase functions deploy trade-scanner --no-verify-jwt
npx supabase functions deploy trading-signals --no-verify-jwt
```

Requires `SUPABASE_ACCESS_TOKEN` (keychain was empty on 2026-08-17). `feedback.ts` ships
with the auto-trader build/restart.

## How to re-diagnose next time

Groq: `curl -H "Authorization: Bearer $GROQ_API_KEY" https://api.groq.com/openai/v1/models`
to list currently-available models, then test a tiny completion per model.
Gemini: a 404 with "no longer available" means Google retired it — move to the next `2.x` flash.
