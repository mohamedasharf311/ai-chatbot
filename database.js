const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

module.exports = {
  // حفظ رسالة
  async saveMessage(sessionId, userMsg, botReply) {
    const { error } = await supabase.from('conversations').insert({
      session_id: sessionId,
      user_message: userMsg,
      bot_reply: botReply
    });
    if (error) throw error;
  },

  // إحصائيات عامة
  async getStats() {
    const { count: total } = await supabase
      .from('conversations')
      .select('*', { count: 'exact', head: true });

    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);

    const { count: today } = await supabase
      .from('conversations')
      .select('*', { count: 'exact', head: true })
      .gte('created_at', todayStart.toISOString());

    // عدد الجلسات الفريدة (آخر 1000 صف عشان الأداء)
    const { data: sessions } = await supabase
      .from('conversations')
      .select('session_id')
      .order('created_at', { ascending: false })
      .limit(1000);

    const uniqueSessions = new Set((sessions || []).map(s => s.session_id)).size;

    return {
      totalMessages: total || 0,
      todayMessages: today || 0,
      totalSessions: uniqueSessions
    };
  },

  // آخر الرسائل
  async getRecentMessages(limit = 50) {
    const { data, error } = await supabase
      .from('conversations')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(limit);
    if (error) throw error;
    return data || [];
  },

  // أكثر الأسئلة تكراراً
  async getTopQuestions(limit = 10) {
    const { data } = await supabase
      .from('conversations')
      .select('user_message')
      .order('created_at', { ascending: false })
      .limit(500);

    const counts = {};
    (data || []).forEach(row => {
      const msg = (row.user_message || '').trim();
      if (msg) counts[msg] = (counts[msg] || 0) + 1;
    });

    return Object.entries(counts)
      .map(([user_message, count]) => ({ user_message, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, limit);
  },

  // مسح كل شيء
  async clearAll() {
    await supabase.from('conversations').delete().neq('id', 0);
  }
};
