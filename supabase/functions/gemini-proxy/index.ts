// Portfolio Assistant - Gemini Proxy Edge Function
// Dedicated to Suggested Finds stock discovery (Gemini Flash)
// Keeps API keys server-side, never exposed to the browser
// Separation: Groq = Portfolio AI Analysis | Gemini = Suggested Finds Discovery

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const MODEL = 'gemini-2.5-flash';
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;

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
    if (key1) API_KEYS.push(key1);
    if (key2) API_KEYS.push(key2);

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

    console.log(`[Gemini Proxy] ${type} request (${prompt.length} chars), ${API_KEYS.length} key(s)`);

    const body = JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: {
        temperature,
        maxOutputTokens,
        thinkingConfig: { thinkingBudget: 0 },
      },
    });

    // Try each key — if key1 is rate-limited, use key2
    let response: Response | null = null;

    for (let i = 0; i < API_KEYS.length; i++) {
      console.log(`[Gemini Proxy] Trying key ${i + 1}/${API_KEYS.length}...`);
      response = await fetch(`${GEMINI_URL}?key=${API_KEYS[i]}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
      });

      if (response.ok) {
        console.log(`[Gemini Proxy] Success with key ${i + 1}`);
        break;
      }

      if (response.status === 429 && i < API_KEYS.length - 1) {
        console.warn(`[Gemini Proxy] Key ${i + 1} rate-limited, rotating...`);
        continue;
      }

      // Last key or non-429 error — fall through
      break;
    }

    if (!response || !response.ok) {
      const errText = response ? await response.text() : 'No keys available';
      const status = response?.status || 429;
      console.error(`[Gemini Proxy] Failed (${status}):`, errText.slice(0, 200));
      return new Response(
        JSON.stringify({ error: `Gemini API error: ${status}`, details: errText }),
        { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const data = await response.json();
    const text = data?.candidates?.[0]?.content?.parts?.[0]?.text ?? '';

    if (!text) {
      console.error('[Gemini Proxy] Empty response');
      return new Response(
        JSON.stringify({ error: 'Empty response from Gemini' }),
        { status: 502, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    console.log(`[Gemini Proxy] ${MODEL} returned ${text.length} chars`);

    return new Response(
      JSON.stringify({ text, model: MODEL, type }),
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
