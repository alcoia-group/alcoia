// server/index.js - TL;DR backend
// Uses Groq API (ultra-fast inference, free tier available)
// Setup: cp .env.example .env -> add GROQ_API_KEY -> npm install -> node index.js

require('dotenv').config();
const express = require('express');
const cors    = require('cors');

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '2mb' }));

const GROQ_API_KEY = process.env.GROQ_API_KEY || '';
const GROQ_MODEL   = process.env.GROQ_MODEL   || 'llama-3.1-8b-instant'; // fast + free

if (!GROQ_API_KEY) {
  console.warn('\n WARNING: GROQ_API_KEY not set.');
  console.warn('   Get a free key at: https://console.groq.com');
  console.warn('   Add it to server/.env as: GROQ_API_KEY=gsk_...');
  console.warn('   Running in LOCAL-ONLY mode (truncated responses)\n');
} else {
  console.log('Groq API key found. Model:', GROQ_MODEL);
}

// Prompt builder - different prompt per cognitive state / mode
function buildPrompt(text, mode) {
  const prompts = {
    tldr:
      `You are a reading assistant embedded in a browser extension. ` +
      `Give a concise TL;DR (2-4 sentences) of the following text:\n\n${text}`,

    explain_more:
      `The reader appears confused. Explain the following text clearly ` +
      `in simple language, as if explaining to a smart but non-expert reader. ` +
      `Use a concrete example if it helps:\n\n${text}`,

    explain_code:
      `Explain what the following code does, step by step. ` +
      `Focus on WHAT it does and WHY, not just HOW. ` +
      `Write for a developer returning to this code after a long break:\n\n${text}`,

    simplify:
      `The reader is cognitively overloaded. Rewrite the following in much simpler language. ` +
      `Use short sentences. Break complex ideas into bullet points. ` +
      `Prioritise the most important point:\n\n${text}`,
  };
  const base = prompts[mode] || prompts.tldr;
  return base + '\n\nRespond in the same language as the input. Be concise (max 3-4 sentences).';
}

// Call Groq API (OpenAI-compatible endpoint)
async function callGroq(prompt) {
  const resp = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${GROQ_API_KEY}`,
      'Content-Type':  'application/json',
    },
    body: JSON.stringify({
      model:       GROQ_MODEL,
      messages:    [{ role: 'user', content: prompt }],
      temperature: 0.3,
      max_tokens:  350,
    }),
  });

  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`Groq API ${resp.status}: ${err}`);
  }
  const data = await resp.json();
  return data.choices?.[0]?.message?.content || null;
}

// Main summarize endpoint (called by content.js)
app.post('/api/summarize', async (req, res) => {
  const { text = '', mode = 'tldr' } = req.body || {};

  if (!text || text.trim().length < 3) {
    return res.status(400).json({ error: 'No text provided.' });
  }

  const prompt = buildPrompt(text.slice(0, 4000), mode);

  // Local-only fallback (no API key)
  if (!GROQ_API_KEY) {
    const snippet = text.slice(0, 220);
    return res.json({
      summary: `[Local mode - no API key] ${snippet}${text.length > 220 ? '...' : ''}`,
    });
  }

  try {
    const summary = await callGroq(prompt);
    if (!summary) return res.status(500).json({ error: 'Empty response from Groq.' });
    res.json({ summary });
  } catch (err) {
    console.error('Groq request failed:', err.message);
    res.status(500).json({ error: 'AI request failed', detail: err.message });
  }
});

// Health check - useful to test from browser
app.get('/health', (req, res) => {
  res.json({
    status:  'ok',
    model:   GROQ_MODEL,
    api_key: GROQ_API_KEY ? 'set' : 'missing',
  });
});

app.listen(PORT, () => {
  console.log(`TL;DR backend running on http://localhost:${PORT}`);
  console.log(`Health: http://localhost:${PORT}/health`);
});