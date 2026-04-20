// server/index.js — TL;DR AI Backend (v2 — improved prompting)
// Uses Groq API (fast, free tier available at console.groq.com)

require('dotenv').config();
const express = require('express');
const cors    = require('cors');

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '2mb' }));

const GROQ_API_KEY = process.env.GROQ_API_KEY || '';
const GROQ_MODEL   = process.env.GROQ_MODEL   || 'llama-3.1-8b-instant';

if (!GROQ_API_KEY) {
  console.warn('\n  WARNING: GROQ_API_KEY not set in server/.env');
  console.warn('  Get a free key at https://console.groq.com');
  console.warn('  Running in local-only mode (no AI)\n');
} else {
  console.log(`  Groq API ready — model: ${GROQ_MODEL}`);
}

// ── Prompts ────────────────────────────────────────────────────────────────
// Design principles:
//   1. Role context first — tell the model exactly what it is doing
//   2. Specific output format — length, tone, structure
//   3. Audience awareness — non-expert, returning reader
//   4. No padding — short responses are better for a popup

function buildPrompt(text, mode) {
  const escaped = text.trim();

  const prompts = {

    // Selection: user highlighted text and wants a quick summary
    tldr: `You are a reading assistant embedded in a browser. The user has highlighted the following text and wants a concise summary.

Write 2–3 sentences that capture the core point. Start directly — no preamble like "This text discusses...". Write as if explaining to a smart friend who hasn't read it.

Text:
${escaped}`,

    // Gaze-triggered: classifier detected confusion (re-reading, stuck)
    explain_more: `You are a reading assistant. The reader's eye movements indicate they are confused by this passage — they are re-reading it repeatedly and making no progress through the page.

Explain this passage clearly. Your response must:
- Open with the single most important idea in one plain sentence
- Then explain WHY it works / WHY it matters in 2–3 sentences
- Give one concrete, real-world analogy or example if the concept is abstract
- Avoid jargon unless you immediately define it

Do not summarise. Explain. Make the concept click.

Passage:
${escaped}`,

    // Gaze-triggered: classifier detected overload (extreme regression, very short saccades)
    simplify: `You are a reading assistant. The reader's eye movements show they are cognitively overloaded — their eyes keep jumping back to the start of lines and they cannot move forward.

Rewrite this passage in plain language. Your response must:
- Use short sentences (max 15 words each)
- One idea per sentence
- Replace all jargon with everyday words
- If there are multiple points, use a numbered list
- Cut everything that isn't essential

Target reading level: someone intelligent but unfamiliar with this topic.

Original passage:
${escaped}`,

    // User selected code — detected by content.js heuristic
    explain_code: `You are a code explainer embedded in a browser extension. The reader selected this code and wants to understand it.

Explain what this code does in plain language. Structure your response as:
1. What it does (one sentence — the purpose)
2. How it works (step by step, in the order things execute)
3. Any important side effects, edge cases, or things to watch out for

Write for a developer who knows programming but is unfamiliar with this specific code. No need to define basic concepts like variables or loops.

Code:
${escaped}`,

    // "Explain More" button in popup — user wants deeper explanation
    deep_explain: `You are a reading assistant. The user has read an initial explanation and wants to go deeper.

Provide a thorough explanation of the following passage. Include:
- The underlying mechanism or principle
- Why it is designed this way (historical context or practical reason if relevant)
- A concrete example or analogy
- Any common misconceptions worth addressing

Be thorough but clear. No bullet points — write in flowing prose.

Passage:
${escaped}`,
  };

  return (prompts[mode] || prompts.tldr) +
    '\n\nRespond in the same language as the passage. Keep your response under 120 words unless the complexity truly demands more.';
}

// ── Groq call ──────────────────────────────────────────────────────────────
async function callGroq(prompt, mode) {
  // Use a slightly smarter model for deep explanations
  const model = mode === 'deep_explain'
    ? (process.env.GROQ_SMART_MODEL || 'llama-3.3-70b-versatile')
    : GROQ_MODEL;

  const resp = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${GROQ_API_KEY}`,
      'Content-Type':  'application/json',
    },
    body: JSON.stringify({
      model,
      messages: [
        {
          role: 'system',
          content: 'You are a precise, helpful reading assistant. You give clear, direct responses. You never pad your responses with phrases like "Certainly!", "Great question!", or "In conclusion". You get straight to the point.',
        },
        { role: 'user', content: prompt },
      ],
      temperature: 0.25,   // low temp = more consistent, factual output
      max_tokens:  220,    // enough for a good explanation, not so much it rambles
      top_p:       0.9,
    }),
  });

  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`Groq ${resp.status}: ${err}`);
  }
  const data = await resp.json();
  return data.choices?.[0]?.message?.content?.trim() || null;
}

// ── Main endpoint ──────────────────────────────────────────────────────────
app.post('/api/summarize', async (req, res) => {
  const { text = '', mode = 'tldr' } = req.body || {};

  if (!text || text.trim().length < 3) {
    return res.status(400).json({ error: 'No text provided.' });
  }

  // Cap input at 4000 chars to avoid token limit issues
  const clipped = text.trim().slice(0, 4000);
  const prompt  = buildPrompt(clipped, mode);

  // Local-only mode (no API key)
  if (!GROQ_API_KEY) {
    const canned = mode === 'tldr'
      ? `[No API key] ${clipped.slice(0, 200)}${clipped.length > 200 ? '...' : ''}`
      : `[No API key — set GROQ_API_KEY in server/.env]`;
    return res.json({ summary: canned });
  }

  try {
    const summary = await callGroq(prompt, mode);
    if (!summary) return res.status(500).json({ error: 'Empty response from Groq.' });
    res.json({ summary });
  } catch (err) {
    console.error('[TL;DR] Groq error:', err.message);
    res.status(500).json({ error: 'AI request failed', detail: err.message });
  }
});

// ── Health check ───────────────────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({
    status:   'ok',
    model:    GROQ_MODEL,
    api_key:  GROQ_API_KEY ? 'set' : 'missing',
  });
});

app.listen(PORT, () => {
  console.log(`\n  TL;DR backend → http://localhost:${PORT}`);
  console.log(`  Health check  → http://localhost:${PORT}/health\n`);
});