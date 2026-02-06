// Portfolio Assistant - AI Proxy Edge Function
// Two-model pipeline: tries 70B first (best reasoning), falls back to 32B if rate-limited
// Keeps API keys server-side, never exposed to the browser

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';
const PRIMARY_MODEL = 'llama-3.3-70b-versatile'; // Best analyst brain (100K TPD)
const FALLBACK_MODEL = 'qwen/qwen3-32b'; // Smart fallback (higher limits)

const SYSTEM_MESSAGE = `You are a portfolio analyst. The user OWNS these stocks. Your job: detect if any action is warranted TODAY.

The user has selected a RISK PROFILE (see "Risk:" field). Adapt your behavior accordingly:

BUY PHILOSOPHY — BUY ON DIPS, NOT AT HIGHS:
- BUY signals should come from QUALITY STOCKS PULLING BACK — a dip on a strong company is a buying opportunity.
- A stock that is UP today is almost NEVER a BUY. You don't chase green candles.
- The only exception: a stock is deeply undervalued even after today's gain (e.g., trading at 40% off 52W high despite today's +2%).
- If "price surge" appears in the trigger data, lean toward null or SELL — not BUY.
- If "price dip" or "quality dip" appears, THAT is where BUY opportunities live.

RISK PROFILES:
- aggressive: Opportunistic. Lean into fear — if scores are decent, news is benign, and price dipped, that's a setup. Higher tolerance for volatility and uncertainty.
- moderate: Selective. Only act when scores, news, AND price all align clearly. If any signal is ambiguous, default to null. Most stocks most days = no action.
- conservative: Skeptical. Assume no action unless the case is overwhelming — high scores, strong news, meaningful dip, and analyst support all pointing the same way. Almost always null.

SELL rules are the SAME across all profiles — cutting losers is always disciplined:
- Fundamentals clearly deteriorating (avg score <45, negative margins, weak earnings)
- Earnings quality or guidance weakening
- News indicates structural or long-term business risk
- Quality is low AND momentum is negative (not just a bad day — a bad stock)

DECISION FRAMEWORK — evaluate each stock on:

1. FUNDAMENTAL TRAJECTORY: Improving, Stable, or Deteriorating?
2. PRICE vs INFORMATION: Has price moved materially relative to available info? Overreaction = buy. Delayed reaction = sell.
3. NEWS SEVERITY: Benign (short-term) vs Serious (structural, long-term)

null — when no clear conviction exists for the given risk profile.

RULES:
- Do NOT buy or sell solely due to unrealized gains/losses from purchase price
- Use position size only to flag concentration risk, not as a trade trigger
- Use ONLY the scores, metrics, and news provided — do not infer or fabricate
- A weak stock dipping is still a SELL if fundamentals are broken

EXAMPLES:
aggressive: AAPL -2.5%, Q:78 E:70, no bad news → BUY MEDIUM "Quality dip, add on weakness"
moderate: AMZN -4%, Q:82 E:75, no bad news → BUY HIGH "Quality dip, fear is opportunity"
conservative: AAPL -2.5%, Q:78 E:70, no news → null "Dip not deep enough"
any profile: ORCL earnings miss, Q:45 M:28 → SELL HIGH "Business deteriorating"
any profile: MSFT flat, Q:88, no news → null "No catalyst today"

FAILURE CONDITIONS — you have failed if you:
- Ignore the user's risk profile
- Recommend actions without clear justification
- Use emotional or speculative language
- Act on price movement alone without fundamental backing

Respond ONLY with valid JSON (no markdown, no backticks, no thinking tags):
{"buyPriority":"BUY"|"SELL"|null,"confidence":"HIGH"|"MEDIUM"|"LOW"|null,"cardNote":"5-8 words max","reasoning":"2-3 factual sentences citing scores, metrics, and news","summary":"one-line company description"}`;

interface RequestPayload {
  prompt: string;
  temperature?: number;
  maxOutputTokens?: number;
}

async function callGroq(
  apiKey: string,
  model: string,
  prompt: string,
  temperature: number,
  maxTokens: number
): Promise<Response> {
  return fetch(GROQ_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: SYSTEM_MESSAGE },
        { role: 'user', content: prompt },
      ],
      temperature,
      max_tokens: maxTokens,
    }),
  });
}

function cleanResponse(text: string): string {
  // Strip <think>...</think> tags (Qwen3 chain-of-thought)
  let cleaned = text.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
  // Strip markdown fences if present
  cleaned = cleaned
    .replace(/```json?\s*/g, '')
    .replace(/```/g, '')
    .trim();
  return cleaned;
}

Deno.serve(async req => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    const GROQ_API_KEY = Deno.env.get('GROQ_API_KEY');
    if (!GROQ_API_KEY) {
      return new Response(JSON.stringify({ error: 'GROQ_API_KEY not configured on server' }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const { prompt, temperature = 0.1, maxOutputTokens = 2000 }: RequestPayload = await req.json();

    if (!prompt) {
      return new Response(JSON.stringify({ error: 'Missing required parameter: prompt' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Try primary model (70B) first
    let response = await callGroq(
      GROQ_API_KEY,
      PRIMARY_MODEL,
      prompt,
      temperature,
      maxOutputTokens
    );
    let usedModel = PRIMARY_MODEL;

    // If 70B is rate-limited, fall back to 32B
    if (response.status === 429) {
      console.warn(
        `Primary model (${PRIMARY_MODEL}) rate-limited, falling back to ${FALLBACK_MODEL}`
      );
      response = await callGroq(GROQ_API_KEY, FALLBACK_MODEL, prompt, temperature, maxOutputTokens);
      usedModel = FALLBACK_MODEL;

      // If fallback also 429s, wait 3s and try fallback once more
      if (response.status === 429) {
        console.warn(`Fallback also rate-limited, waiting 3s and retrying...`);
        await new Promise(r => setTimeout(r, 3000));
        response = await callGroq(
          GROQ_API_KEY,
          FALLBACK_MODEL,
          prompt,
          temperature,
          maxOutputTokens
        );
      }
    }

    if (!response.ok) {
      const errText = await response.text();
      console.error(`Groq API error ${response.status} (${usedModel}):`, errText);
      return new Response(
        JSON.stringify({ error: `AI API error: ${response.status}`, details: errText }),
        { status: response.status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const data = await response.json();
    const rawText = data?.choices?.[0]?.message?.content ?? '';
    const text = cleanResponse(rawText);

    return new Response(JSON.stringify({ text, model: usedModel }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (err) {
    console.error('AI proxy error:', err);
    return new Response(JSON.stringify({ error: 'Internal server error' }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
