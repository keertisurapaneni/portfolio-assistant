// Portfolio Assistant - Gemini Proxy Edge Function
// Dedicated to Suggested Finds stock discovery (Gemini Flash)
// Keeps API keys server-side, never exposed to the browser
// Separation: Groq = Portfolio AI Analysis | Gemini = Suggested Finds Discovery

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// Model fallback: try best quality first, fall back on rate limits
// Each model has its own free-tier daily quota
const MODELS = ['gemini-2.5-flash', 'gemini-2.0-flash', 'gemini-2.0-flash-lite'];
const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

interface RequestPayload {
  prompt: string;
  type: 'discover_compounders' | 'discover_goldmines' | 'analyze_themes';
  temperature?: number;
  maxOutputTokens?: number;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    // Collect all available API keys for rotation
    const API_KEYS: string[] = [];
    const key1 = Deno.env.get('GEMINI_API_KEY');
    const key2 = Deno.env.get('GEMINI_API_KEY_2');
    const key3 = Deno.env.get('GEMINI_API_KEY_3');
    if (key1) API_KEYS.push(key1);
    if (key2) API_KEYS.push(key2);
    if (key3) API_KEYS.push(key3);

    if (API_KEYS.length === 0) {
      return new Response(
        JSON.stringify({ error: 'No GEMINI_API_KEY configured on server' }),
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

    console.log(`[Gemini Proxy] ${type} request (${prompt.length} chars), ${API_KEYS.length} key(s), ${MODELS.length} model(s)`);

    const body = JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: {
        temperature,
        maxOutputTokens,
        thinkingConfig: { thinkingBudget: 0 },
      },
    });

    // Try each model × each key — best model first, fall back on 429
    let response: Response | null = null;
    let usedModel = MODELS[0];

    outer:
    for (const model of MODELS) {
      for (let i = 0; i < API_KEYS.length; i++) {
        console.log(`[Gemini Proxy] Trying ${model} with key ${i + 1}/${API_KEYS.length}...`);
        response = await fetch(`${GEMINI_BASE}/${model}:generateContent?key=${API_KEYS[i]}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body,
        });

        if (response.ok) {
          usedModel = model;
          console.log(`[Gemini Proxy] Success with ${model}, key ${i + 1}`);
          break outer;
        }

        if (response.status === 429) {
          console.warn(`[Gemini Proxy] ${model} key ${i + 1} rate-limited, trying next...`);
          continue;
        }

        // Non-429 error — stop trying this model
        break;
      }
    }

    if (!response || !response.ok) {
      const errText = response ? await response.text() : 'No keys available';
      const status = response?.status || 429;
      console.error(`[Gemini Proxy] All models/keys failed (${status}):`, errText.slice(0, 200));
      return new Response(
        JSON.stringify({ error: `Gemini API error: ${status}`, details: errText }),
        { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const data = await response.json();
    const text = data?.candidates?.[0]?.content?.parts?.[0]?.text ?? '';

    if (!text) {
      console.error(`[Gemini Proxy] Empty response from ${usedModel}`);
      return new Response(
        JSON.stringify({ error: 'Empty response from Gemini' }),
        { status: 502, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    console.log(`[Gemini Proxy] ${usedModel} returned ${text.length} chars`);

    return new Response(
      JSON.stringify({ text, model: usedModel, type }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  } catch (err) {
    console.error('[Gemini Proxy] Error:', err);
    return new Response(
      JSON.stringify({ error: 'Internal server error' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
