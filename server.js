require('dotenv').config();
const express = require('express');
const cors = require('cors');
const OpenAI = require('openai');
const path = require('path');
const db = require('./database');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ====== إعدادات الشركة ======
const COMPANY_CONFIG = {
  name: process.env.COMPANY_NAME || "شركتي",
  description: process.env.COMPANY_DESC || "شركة متخصصة في تقديم خدمات مميزة",
  language: "العربية",
  tone: "ودود ومهني"
};

// ====== OpenRouter ======
const openai = new OpenAI({
  apiKey: process.env.OPENROUTER_API_KEY,
  baseURL: "https://openrouter.ai/api/v1",
  defaultHeaders: {
    "HTTP-Referer": process.env.SITE_URL || "http://localhost:3000",
    "X-Title": COMPANY_CONFIG.name
  }
});

// موديلات مجانية مع fallback
const FREE_MODELS = [
  "meta-llama/llama-3.3-70b-instruct:free",
  "google/gemini-2.0-flash-exp:free",
  "deepseek/deepseek-chat-v3-0324:free",
  "qwen/qwen-2.5-72b-instruct:free"
];

// System Prompt
const systemPrompt = `أنت مساعد خدمة عملاء ذكي لشركة "${COMPANY_CONFIG.name}".
وصف الشركة: ${COMPANY_CONFIG.description}
لغة التواصل: ${COMPANY_CONFIG.language}
الأسلوب: ${COMPANY_CONFIG.tone}

قواعدك:
- رد بإيجاز ووضوح
- لو مش متأكد من معلومة، اعتذر واقترح التواصل مع الدعم
- كن مفيداً ومحترماً
- لا تخرج عن موضوع خدمات الشركة`;

// دالة استدعاء AI مع fallback
async function callAI(messages) {
  const preferred = process.env.MODEL;
  const models = preferred 
    ? [preferred, ...FREE_MODELS.filter(m => m !== preferred)]
    : FREE_MODELS;

  let lastError;
  for (const model of models) {
    try {
      const completion = await openai.chat.completions.create({
        model,
        messages,
        temperature: 0.7,
        max_tokens: 500
      });
      console.log(`✅ Used model: ${model}`);
      return completion.choices[0]?.message?.content;
    } catch (err) {
      console.warn(`⚠️ ${model} failed: ${err.message}`);
      lastError = err;
    }
  }
  throw lastError || new Error("All models failed");
}

// ====== Chat Endpoint ======
app.post('/api/chat', async (req, res) => {
  try {
    const { message, history = [], sessionId } = req.body;

    if (!message || typeof message !== 'string') {
      return res.status(400).json({ error: 'الرسالة مطلوبة' });
    }

    const messages = [
      { role: 'system', content: systemPrompt },
      ...history.slice(-10),
      { role: 'user', content: message }
    ];

    const reply = await callAI(messages);

    // حفظ في Supabase (async - مش بنستنى عشان الرد يبقى سريع)
    if (sessionId) {
      db.saveMessage(sessionId, message, reply)
        .catch(e => console.error('DB save error:', e.message));
    }

    res.json({ reply });

  } catch (error) {
    console.error('Chat error:', error.message);
    res.status(500).json({ error: 'حدث خطأ في المعالجة' });
  }
});

// ====== Admin Endpoints ======
app.get('/api/admin/stats', async (req, res) => {
  const password = req.headers['x-admin-password'];
  if (password !== process.env.ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  try {
    res.json({
      stats: await db.getStats(),
      recent: await db.getRecentMessages(30),
      topQuestions: await db.getTopQuestions(10)
    });
  } catch (e) {
    console.error('Admin error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/admin/clear', async (req, res) => {
  const password = req.headers['x-admin-password'];
  if (password !== process.env.ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  try {
    await db.clearAll();
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ====== Health Check ======
app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    company: COMPANY_CONFIG.name, 
    provider: 'OpenRouter',
    database: 'Supabase'
  });
});

// ====== Widget JS ======
app.get('/widget.js', (req, res) => {
  res.type('application/javascript');
  res.send(`
    (function() {
      const script = document.currentScript;
      const host = new URL(script.src).origin;
      
      const btn = document.createElement('div');
      btn.innerHTML = '💬';
      btn.style.cssText = 'position:fixed;bottom:20px;left:20px;width:60px;height:60px;background:linear-gradient(135deg,#667eea,#764ba2);border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:28px;cursor:pointer;z-index:99999;box-shadow:0 4px 20px rgba(0,0,0,0.3);';
      
      const iframe = document.createElement('iframe');
      iframe.src = host + '/?widget=1';
      iframe.style.cssText = 'position:fixed;bottom:90px;left:20px;width:380px;height:600px;border:none;border-radius:16px;box-shadow:0 10px 40px rgba(0,0,0,0.3);z-index:99999;display:none;background:#fff;';
      
      btn.onclick = () => {
        iframe.style.display = iframe.style.display === 'none' ? 'block' : 'none';
      };
      
      document.body.appendChild(btn);
      document.body.appendChild(iframe);
    })();
  `);
});

app.listen(PORT, () => {
  console.log(`✅ Server running on port ${PORT}`);
  console.log(`🏢 Company: ${COMPANY_CONFIG.name}`);
  console.log(`🆓 AI: OpenRouter (Free)`);
  console.log(`💾 DB: Supabase`);
});
