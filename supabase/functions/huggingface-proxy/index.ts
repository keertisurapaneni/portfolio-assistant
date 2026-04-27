// Portfolio Assistant - Suggested Finds Proxy Edge Function
// Dedicated to Suggested Finds stock discovery (Groq API)
// Keeps API keys server-side, never exposed to the browser
// LLM split: Groq = Portfolio AI + Suggested Finds | Gemini = Trading Signals
// Note: Migrated from HuggingFace router (dropped large LLM support July 2025)

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';
// Model fallback: try best quality first, fall back on rate limits
const GROQ_MODELS = [
  'llama-3.3-70b-versatile',   // Best reasoning for stock discovery
  'qwen/qwen3-32b',            // Smart fallback with higher limits
  'llama3-8b-8192',            // Last resort
];

interface RequestPayload {
  prompt: string;
  type: 'discover_compounders' | 'discover_goldmines' | 'analyze_themes';
  temperature?: number;
  maxOutputTokens?: number;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  try {
    const GROQ_API_KEY = Deno.env.get('GROQ_API_KEY');

    if (!GROQ_API_KEY) {
      return new Response(
        JSON.stringify({ error: 'No GROQ_API_KEY configured on server' }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const { prompt, type, temperature = 0.7, maxOutputTokens = 4000 }: RequestPayload =
      await req.json();

    if (!prompt || !type) {
      return new Response(
        JSON.stringify({ error: 'Missing required parameters: prompt, type' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const validTypes = ['discover_compounders', 'discover_goldmines', 'analyze_themes'];
    if (!validTypes.includes(type)) {
      return new Response(
        JSON.stringify({ error: `Invalid type. Must be one of: ${validTypes.join(', ')}` }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    console.log(`[Suggested Finds] ${type} request (${prompt.length} chars)`);

    let response: Response | null = null;
    let usedModel = GROQ_MODELS[0];

    for (const model of GROQ_MODELS) {
      console.log(`[Suggested Finds] Trying ${model}...`);
      response = await fetch(GROQ_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${GROQ_API_KEY}`,
        },
        body: JSON.stringify({
          model,
          messages: [{ role: 'user', content: prompt }],
          temperature,
          max_tokens: maxOutputTokens,
        }),
      });

      if (response.ok) {
        usedModel = model;
        console.log(`[Suggested Finds] Success with ${model}`);
        break;
      }

      if (response.status === 429 || response.status === 503) {
        console.warn(`[Suggested Finds] ${model} rate-limited (${response.status}), trying next...`);
        await new Promise(r => setTimeout(r, 2000));
        continue;
      }

      // Non-retryable error — try next model
      console.warn(`[Suggested Finds] ${model} error ${response.status}, trying next...`);
      continue;
    }

    if (!response || !response.ok) {
      const errText = response ? await response.text() : 'No response';
      const status = response?.status || 500;
      console.error(`[Suggested Finds] All models failed (${status}):`, errText.slice(0, 200));
      return new Response(
        JSON.stringify({ error: `LLM API error: ${status}`, details: errText }),
        { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const data = await response.json();
    const rawText = data?.choices?.[0]?.message?.content ?? '';
    // Strip <think>...</think> tags emitted by reasoning models (e.g. Qwen3)
    const text = rawText.replace(/<think>[\s\S]*?<\/think>/g, '').trim();

    if (!text) {
      console.error(`[Suggested Finds] Empty response from ${usedModel}`);
      return new Response(
        JSON.stringify({ error: 'Empty response from LLM' }),
        { status: 502, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    console.log(`[Suggested Finds] ${usedModel} returned ${text.length} chars`);

    return new Response(
      JSON.stringify({ text, model: usedModel, type }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  } catch (err) {
    console.error('[Suggested Finds] Error:', err);
    return new Response(
      JSON.stringify({ error: 'Internal server error' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
