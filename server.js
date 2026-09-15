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

// ====== جلب الموديلات المجانية تلقائياً ======
let freeModelsCache = [];
let lastFetch = 0;
const CACHE_DURATION = 1000 * 60 * 60; // ساعة

async function getFreeModels() {
  // لو الكاش لسه صالح
  if (freeModelsCache.length && Date.now() - lastFetch < CACHE_DURATION) {
    return freeModelsCache;
  }

  try {
    console.log('🔄 Fetching free models from OpenRouter...');
    const res = await fetch('https://openrouter.ai/api/v1/models');
    const data = await res.json();

    // فلترة الموديلات المجانية (سعر 0)
    const free = data.data
      .filter(m => {
        const p = m.pricing || {};
        return parseFloat(p.prompt || '1') === 0 
            && parseFloat(p.completion || '1') === 0;
      })
      .map(m => m.id)
      .filter(id => id.includes(':free')) // عشان نضمن
      .slice(0, 10); // أول 10

    if (free.length) {
      freeModelsCache = free;
      lastFetch = Date.now();
      console.log(`✅ Found ${free.length} free models:`, free.slice(0, 3).join(', '), '...');
    }

    return freeModelsCache;
  } catch (err) {
    console.error('❌ Failed to fetch models:', err.message);
    // fallback لقائمة ثابتة
    return freeModelsCache.length ? freeModelsCache : [
      "meta-llama/llama-3.1-8b-instruct:free"
    ];
  }
}

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

// دالة استدعاء AI مع fallback ذكي
async function callAI(messages) {
  const preferred = process.env.MODEL;
  const autoModels = await getFreeModels();

  // ترتيب: الموديل المفضل أولاً، ثم الباقي
  const models = preferred 
    ? [preferred, ...autoModels.filter(m => m !== preferred)]
    : autoModels;

  let lastError;
  for (const model of models) {
    try {
      console.log(`🤖 Trying: ${model}`);
      const completion = await openai.chat.completions.create({
        model,
        messages,
        temperature: 0.7,
        max_tokens: 500
      });
      console.log(`✅ Success with: ${model}`);
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

    if (sessionId) {
      db.saveMessage(sessionId, message, reply)
        .catch(e => console.error('DB save error:', e.message));
    }

    res.json({ reply });

  } catch (error) {
    console.error('Chat error:', error.message);
    res.status(500).json({ 
      error: 'حدث خطأ في المعالجة',
      details: error.message 
    });
  }
});

// ====== Endpoint لمعاينة الموديلات المتاحة ======
app.get('/api/models', async (req, res) => {
  const models = await getFreeModels();
  res.json({ 
    count: models.length, 
    models,
    cached_at: new Date(lastFetch).toISOString()
  });
});

// ====== Admin ======
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

// ====== Health ======
app.get('/health', async (req, res) => {
  const models = await getFreeModels();
  res.json({ 
    status: 'ok', 
    company: COMPANY_CONFIG.name, 
    provider: 'OpenRouter',
    database: 'Supabase',
    free_models_count: models.length
  });
});

// ====== Widget ======
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
  console.log(`🆓 AI: OpenRouter (Auto free models)`);
  console.log(`💾 DB: Supabase`);
  // جلب الموديلات عند البدء
  getFreeModels();
});
