const express = require('express');
const cors = require('cors');
const axios = require('axios');

const app = express();
app.use(cors());
app.use(express.json({ limit: '1mb' }));

const PORT = process.env.PORT || 3000;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';

if (!OPENAI_API_KEY) {
  console.warn('Warning: OPENAI_API_KEY not set. Set OPENAI_API_KEY env var to enable AI calls.');
}


app.post('/api/summarize', async (req, res) => {
  const { text = '', mode = 'tldr' } = req.body || {};
  if (!text || text.trim().length < 3) return res.status(400).json({ error: 'No text provided.' });

  // Prompt selection
  let prompt;
  if (mode === 'explain_more') {
    prompt = `Explain the following text in more detail and give examples where useful:\n\n${text}`;
  } else if (mode === 'explain_code') {
    prompt = `Explain the following code in simple, clear language as if to a developer returning to this project after a long break. Focus on what it does, why, and any important details. Avoid jargon.\n\n${text}`;
  } else {
    prompt = `Provide a short TL;DR (2-4 sentences), focusing on the key points of the text below:\n\n${text}`;
  }

  // Ask the model to reply in the same language as the input and keep explanations simple and accessible.
  prompt += `\n\nPlease respond in the same language as the input. Keep explanations simple and accessible for a developer returning to code after a long break.`;

  // Local-only mode: if OPENAI_API_KEY is not set, return a simple canned summary so the extension can be tested offline.
  if (!OPENAI_API_KEY) {
    const canned = (mode === 'explain_more')
      ? `Explanation (local-only): ${text.slice(0, 800)}${text.length > 800 ? '...' : ''}`
      : `TL;DR (local-only): ${text.length > 240 ? text.slice(0, 237) + '...' : text}`;
    return res.json({ summary: canned });
  }

  try {
    const resp = await axios.post('https://api.openai.com/v1/chat/completions', {
      model: 'gpt-3.5-turbo',
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.2,
      max_tokens: 250
    }, {
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        'Content-Type': 'application/json'
      }
    });

    const summary = resp.data && resp.data.choices && resp.data.choices[0] && resp.data.choices[0].message && resp.data.choices[0].message.content;
    res.json({ summary: summary || 'No content from AI.' });
  } catch (err) {
    console.error('OpenAI request failed', err?.response?.data || err.message);
    res.status(500).json({ error: 'AI request failed', detail: err?.response?.data || err.message });
  }
});

app.listen(PORT, () => console.log(`SRA backend listening on http://localhost:${PORT}`));
