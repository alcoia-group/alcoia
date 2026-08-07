// server/index.js — alcoia AI Backend (v2 — improved prompting)
// Uses Groq API (fast, free tier available at console.groq.com)

require('dotenv').config();
const express = require('express');
const cors    = require('cors');
const path    = require('path');
const fs      = require('fs');
const Q       = require('./questions');
const Sig     = require('./receipt-signing');

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(cors({
  origin: (origin, callback) => {
    // Allow same-origin (no header), Chrome extension, and localhost only.
    // This blocks arbitrary websites from hitting the local server.
    // Requests from the extension are proxied through its background service
    // worker, which sends no page origin — so they land in the `!origin` branch.
    const allowed =
      !origin ||
      /^chrome-extension:\/\//.test(origin) ||
      /^https?:\/\/(localhost|127\.0\.0\.1)/.test(origin);
    // Deny gracefully (no CORS headers) instead of throwing — a thrown error
    // spams the console with a stack trace on every disallowed request.
    callback(null, allowed);
  },
}));
app.use(express.json({ limit: '2mb' }));

// ── Rate limiter (30 req/min per IP) ───────────────────────────────────────
const _rlMap = new Map();
setInterval(() => {
  const cutoff = Date.now() - 60000;
  for (const [ip, ts] of _rlMap) {
    const fresh = ts.filter(t => t > cutoff);
    if (fresh.length === 0) _rlMap.delete(ip); else _rlMap.set(ip, fresh);
  }
}, 60000);
function rateLimit(req, res, next) {
  const ip  = req.ip || '0.0.0.0';
  const now = Date.now();
  const ts  = (_rlMap.get(ip) || []).filter(t => now - t < 60000);
  if (ts.length >= 30) return res.status(429).json({ error: 'Rate limit exceeded. Try again in a minute.' });
  ts.push(now);
  _rlMap.set(ip, ts);
  next();
}

// Questions are more expensive than summaries and are asked far less often,
// so they get their own, tighter bucket rather than sharing the summary one.
const _qRlMap = new Map();
function questionRateLimit(req, res, next) {
  const ip  = req.ip || '0.0.0.0';
  const now = Date.now();
  const ts  = (_qRlMap.get(ip) || []).filter(t => now - t < 60000);
  if (ts.length >= 10) return res.status(429).json({ error: 'Question rate limit exceeded. Try again in a minute.' });
  ts.push(now);
  _qRlMap.set(ip, ts);
  next();
}

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
function buildPrompt(text, mode, context) {
  const escaped  = text.trim();
  const ctxBlock = context
    ? `\n\nFor reference, here is the paragraph that immediately preceded this one:\n"""\n${context.trim()}\n"""\n`
    : '';

  const prompts = {

    tldr: `You are a reading assistant embedded in a browser. The user has highlighted the following text and wants a concise summary.

Write 2–3 sentences that capture the core point. Start directly — no preamble like "This text discusses...". Write as if explaining to a smart friend who hasn't read it.

Text:
${escaped}`,

    explain_more: `You are a reading assistant. The reader has slowed down or gone back over this passage, which suggests it did not land the first time.

Explain this passage clearly. Your response must:
- Open with the single most important idea in one plain sentence
- Then explain WHY it works / WHY it matters in 2–3 sentences
- Give one concrete, real-world analogy or example if the concept is abstract
- Avoid jargon unless you immediately define it

Do not summarise. Explain. Make the concept click.
${ctxBlock}
Passage:
${escaped}`,

    simplify: `You are a reading assistant. The reader is making little progress through this passage and has been re-reading parts of it.

Rewrite this passage in plain language. Your response must:
- Use short sentences (max 15 words each)
- One idea per sentence
- Replace all jargon with everyday words
- If there are multiple points, use a numbered list
- Cut everything that isn't essential

Target reading level: someone intelligent but unfamiliar with this topic.
${ctxBlock}
Original passage:
${escaped}`,

    explain_code: `You are a code explainer embedded in a browser extension. The reader selected this code and wants to understand it.

Explain what this code does in plain language. Structure your response as:
1. What it does (one sentence — the purpose)
2. How it works (step by step, in the order things execute)
3. Any important side effects, edge cases, or things to watch out for

Write for a developer who knows programming but is unfamiliar with this specific code. No need to define basic concepts like variables or loops.

Code:
${escaped}`,

    deep_explain: `You are a reading assistant. The user has read an initial explanation and wants to go deeper.

Provide a thorough explanation of the following passage. Include:
- The underlying mechanism or principle
- Why it is designed this way (historical context or practical reason if relevant)
- A concrete example or analogy
- Any common misconceptions worth addressing

Be thorough but clear. No bullet points — write in flowing prose.

Passage:
${escaped}`,

    define_word: `You are a vocabulary assistant embedded in a browser. A reader hovered over a word while reading and wants to understand it in context.

${escaped}

Your response must:
- Explain what this word or term means IN THIS SPECIFIC CONTEXT (not a general dictionary definition)
- Use plain language, 1–2 sentences
- If it's jargon or a technical term, give a one-phrase real-world analogy
- Do NOT repeat the word in your first sentence

Maximum 50 words.`,

    page_summary: `You are a reading assistant. Give a structured overview of the following article or page so the reader knows what they're getting into before (or after) reading it.

Format your response EXACTLY like this — do not deviate:

**Main argument:** [one sentence — the central claim or purpose of this page]

**Key points:**
• [point 1]
• [point 2]
• [point 3]

**Key terms:** [3–5 important words or concepts, comma-separated]

**Difficulty:** [Easy / Moderate / Dense / Technical] — [one phrase explaining why]

**Read time:** ~[N] min

Page content:
${escaped}`,

    image_context: `You are a reading assistant embedded in a browser. A reader is viewing an image on a web page and needs help understanding it.

Based on the information below, explain in 2–3 sentences:
1. What this image most likely shows or depicts
2. How it connects to the surrounding text
3. The key insight or point the image is making

${escaped}

Be specific. If it appears to be a chart or graph, describe what it measures and the main trend visible. If it's a diagram, describe the relationship shown. Maximum 70 words.`,
  };

  return (prompts[mode] || prompts.tldr) +
    '\n\nRespond in the same language as the passage. Keep your response under 120 words unless the complexity truly demands more.';
}

// ── Groq call ──────────────────────────────────────────────────────────────
async function callGroq(prompt, mode) {
  const smartModes = new Set(['deep_explain', 'page_summary', 'questions']);
  const model = smartModes.has(mode)
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
      temperature: mode === 'questions' ? 0.1 : 0.25,
      max_tokens:  mode === 'questions' ? 900 : mode === 'page_summary' ? 400 : mode === 'define_word' ? 80 : mode === 'image_context' ? 120 : 220,
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
app.post('/api/summarize', rateLimit, async (req, res) => {
  const { text = '', mode = 'tldr', context = '' } = req.body || {};

  if (!text || text.trim().length < 3) {
    return res.status(400).json({ error: 'No text provided.' });
  }

  const limit   = mode === 'page_summary' ? 6000 : mode === 'image_context' ? 800 : 4000;
  const clipped = text.trim().slice(0, limit);
  const prompt  = buildPrompt(clipped, mode, context);

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
    console.error('[alcoia] Groq error:', err.message);
    res.status(500).json({ error: 'AI request failed', detail: err.message });
  }
});

// ── Questions ──────────────────────────────────────────────────────────────
// The primary intervention. A question the reader has to answer is the only
// thing in this system that produces ground truth about comprehension.
const questionCache = Q.createQuestionCache();

app.post('/api/questions', questionRateLimit, async (req, res) => {
  const { text = '', language = '', difficulty = '', count = 2, kind = 'recall' } = req.body || {};

  if (!text || text.trim().length < 120) {
    // Too short to ask anything meaningful about.
    return res.status(400).json({ error: 'Passage too short for a question.' });
  }

  const opts = { count: Q.clampCount(count), kind, language };
  const key = Q.contentHash(text, opts);

  const cached = questionCache.get(key);
  if (cached) return res.json({ questions: cached, cached: true });

  if (!GROQ_API_KEY) {
    return res.status(503).json({ error: 'No API key configured; question generation unavailable.' });
  }

  try {
    const prompt = Q.buildQuestionPrompt(text, opts);
    const raw = await callGroq(prompt, 'questions');
    const questions = Q.parseQuestions(raw, text, opts);

    // Every question must cite a sentence that is actually in the passage.
    // When none survive that check we say so rather than shipping the model's
    // best guess — the client falls back to an explanation.
    if (!questions.length) {
      return res.status(422).json({ error: 'No question passed validation for this passage.' });
    }

    questionCache.set(key, questions);
    res.json({ questions, cached: false });
  } catch (err) {
    console.error('[alcoia] Question generation failed:', err.message);
    res.status(500).json({ error: 'Question generation failed', detail: err.message });
  }
});

// ── Receipts ───────────────────────────────────────────────────────────────
// Signing only. Nothing is stored: the receipt goes back to the reader who
// sent it, and the server keeps no copy. Storing them would make this a
// record-keeping system about people's reading, which is not what it is.
const RECEIPT_SECRET = process.env.RECEIPT_SECRET || '';

if (!RECEIPT_SECRET) {
  console.warn('  RECEIPT_SECRET not set — receipt signing disabled (receipts still generate, unsigned)');
}

app.post('/api/receipt/sign', rateLimit, (req, res) => {
  const receipt = req.body && req.body.receipt;
  if (!receipt || typeof receipt !== 'object') {
    return res.status(400).json({ error: 'No receipt provided.' });
  }
  if (!RECEIPT_SECRET) {
    return res.status(503).json({ error: 'Signing is not configured on this server.' });
  }
  try {
    res.json({ receipt: Sig.sign(receipt, RECEIPT_SECRET) });
  } catch (err) {
    res.status(500).json({ error: 'Signing failed', detail: err.message });
  }
});

app.post('/api/receipt/verify', rateLimit, (req, res) => {
  const receipt = req.body && req.body.receipt;
  if (!receipt || typeof receipt !== 'object') {
    return res.status(400).json({ error: 'No receipt provided.' });
  }
  const result = Sig.verify(receipt, RECEIPT_SECRET);
  // A valid signature means the artifact is unaltered. It is not evidence that
  // the reading happened — the figures come from the reader's own browser.
  res.json({
    ...result,
    means: result.valid
      ? 'This receipt is unchanged since the server issued it. It is not proof that the reading occurred as described.'
      : 'This receipt does not match a signature this server issued.',
  });
});

// ── Demo page ──────────────────────────────────────────────────────────────
// Serves demo.html at http://localhost:3000/demo
// Place demo.html at the project root (same level as the alcoia folder and server/).
// The extension injects normally here because localhost is a secure context.
app.get('/demo', (req, res) => {
  const demoPath = path.join(__dirname, '..', 'demo.html');
  if (fs.existsSync(demoPath)) {
    res.sendFile(demoPath);
  } else {
    res.status(404).send(
      'demo.html not found. Place it at the project root ' +
      '(one level above the server/ folder), then restart the server.'
    );
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
  console.log(`\n  alcoia backend → http://localhost:${PORT}`);
  console.log(`  Health check  → http://localhost:${PORT}/health`);
  console.log(`  Demo page     → http://localhost:${PORT}/demo\n`);
});