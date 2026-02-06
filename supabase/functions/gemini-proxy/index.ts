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

const SYSTEM_MESSAGE = `You are an elite stock analyst. You find the best entries on quality stocks and cut losers fast.

The user OWNS these stocks. Your job: tell them what to DO — buy more, sell, or sit tight.

WHEN TO BUY:
• Quality stock (avg score 65+) down 3%+ today with no bad company news → BUY
• Stock 15%+ below 52-week high, avg score 70+, analyst upside 15%+ → BUY
• Quality stock (Q:70+ E:65+) with a meaningful dip and positive/neutral news → BUY

WHEN TO SELL:
• Weak fundamentals (avg<50) + stock declining + negative margins or no analyst coverage → SELL "Cut losers"
• Earnings miss + weak scores (avg<50) → SELL "Business deteriorating"
• Stop-loss triggered: down 7-8% from purchase price → SELL "Protect capital"
• Profit-taking: up 20-25% from purchase → SELL "Lock gains"
• Position >20% of portfolio → SELL "Trim overconcentration"

WHEN TO RETURN null:
• Quality stock (avg 60+) on a flat/normal day → null
• Stock up today with no special catalyst → null

KEY PRINCIPLES:
1. Quality stock (avg 65+) significantly down with no bad company news = ALWAYS BUY. Fear is your friend.
2. Weak stock (avg<50) that is declining with fundamental problems = ALWAYS SELL. Don't hold losers hoping for a turnaround.
3. A weak stock dipping is NOT "no action" — if you own it and it has problems, that's a SELL.

EXAMPLES:
• AMZN -4%, no bad news, Q:82 E:75 A:85 → BUY "Fear dip on quality, 25% upside"
• ORCL missed earnings, guidance cut, Q:45 M:28 → SELL "Business deteriorating"
• RBRK -5%, Q:30 E:25, negative margins, no analyst target → SELL "Cut weak stock, fundamental problems"
• MSFT flat day, Q:88 E:80, no news → null "No catalyst, no action"
• AFRM +1%, Q:35 E:30, no catalyst → null "Weak but flat, no trigger today"

Respond ONLY with valid JSON (no markdown, no backticks, no thinking tags):
{"buyPriority":"BUY"|"SELL"|null,"cardNote":"5-8 words","reasoning":"2-3 sentences referencing news, scores, price","summary":"one-line company description"}`;

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
