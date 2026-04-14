const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const Anthropic = require('@anthropic-ai/sdk');
const twilio = require('twilio');
const cron = require('node-cron');

const app = express();

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

let _supabase, _anthropic, _twilio;

function getSupabase() {
  if (!_supabase) _supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
  return _supabase;
}
function getAnthropic() {
  if (!_anthropic) _anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  return _anthropic;
}
function getTwilio() {
  if (!_twilio) _twilio = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
  return _twilio;
}

const DISCLAIMER = '⚠️ Dit is geen medisch advies. Bij pijn of twijfel, raadpleeg een arts of kinesist.';

function calcDailyLoad(dayType, rpe) {
  if (dayType === 'rust') return 0;
  if (dayType === 'wedstrijd') return rpe * 1.5;
  return rpe * 1;
}

function calcRiskScore({ dailyLoad, sleep, fatigue, painScore, acwr, prevLoad }) {
  let score = 0;
  if (dailyLoad > 7) score += 2;
  if (prevLoad > 7) score += 2;
  if (sleep <= 2) score += 2;
  if (fatigue >= 4) score += 2;
  if (painScore >= 4) score += 3;
  if (acwr >= 1.3 && acwr <= 1.6) score += 3;
  if (acwr > 1.6) score += 5;
  if (score <= 3) return { score, color: 'groen' };
  if (score <= 6) return { score, color: 'geel' };
  return { score, color: 'rood' };
}

async function calcACWR(userId, todayLoad) {
  const { data } = await getSupabase().from('daily_logs').select('daily_load').eq('user_id', userId).order('date', { ascending: false }).limit(28);
  const loads = data ? data.map(r => r.daily_load) : [];
  const all = [todayLoad, ...loads];
  const acute = all.slice(0, 7).reduce((s, v) => s + v, 0);
  const chronic28 = all.slice(0, 28).reduce((s, v) => s + v, 0) / Math.min(all.length, 28);
  const acwr = chronic28 > 0 ? acute / chronic28 : 0;
  return { acute, chronic28, acwr, prevLoad: loads[0] ?? 0 };
}

async function generateMessage(prompt) {
  const msg = await getAnthropic().messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 300,
    messages: [{ role: 'user', content: prompt }]
  });
  return msg.content[0].text.trim();
}

async function sendWhatsApp(to, body) {
  if (!to) return;
  const num = to.startsWith('whatsapp:') ? to : `whatsapp:${to}`;
  const from = `whatsapp:${process.env.TWILIO_WHATSAPP_NUMBER}`;
  await getTwilio().messages.create({ from, to: num, body });
}

const sessions = {};
const QUESTIONS = [
  { key: 'day_type', text: 'Goedemorgen! 👋\nWat was je dag vandaag?\n1️⃣ Rust\n2️⃣ Training\n3️⃣ Wedstrijd\n\nAntwoord met 1, 2 of 3.' },
  { key: 'rpe', text: 'Hoe zwaar was de inspanning? (RPE)\nSchaal 1–10 👇' },
  { key: 'sleep', text: 'Hoe goed heb je geslapen?\n1 = slecht, 5 = uitstekend 💤' },
  { key: 'fatigue', text: 'Hoe vermoeid voel je je nu?\n1 = fris, 5 = uitgeput 🔋' },
  { key: 'pain_score', text: 'Heb je ergens pijn?\n0 = geen pijn, 10 = hevige pijn 🤕' },
  { key: 'pain_location', text: 'Waar heb je pijn? (bv. "linkerknie", "enkel" of "geen")' }
];
const DAY_MAP = { '1': 'rust', '2': 'training', '3': 'wedstrijd' };

app.post('/webhook/whatsapp', async (req, res) => {
  res.sendStatus(200);
  const from = req.body.From || '';
  const body = (req.body.Body || '').trim();
  const phone = from.replace('whatsapp:', '');
  try {
    const { data: users } = await getSupabase().from('users').select('*').or(`child_phone.eq.${phone},parent_phone.eq.${phone}`).limit(1);
    const user = users?.[0];
    if (!user) { await sendWhatsApp(from, 'Je nummer is niet geregistreerd.\n\n' + DISCLAIMER); return; }

    const isPlayer = user.child_phone === phone;
    if (!sessions[phone] && isPlayer) {
      sessions[phone] = { step: 0, answers: {}, userId: user.id, user };
      await sendWhatsApp(from, QUESTIONS[0].text);
      return;
    }
    if (!sessions[phone]) { await sendWhatsApp(from, 'Check-ins worden gestart door de speler 👟'); return; }

    const s = sessions[phone];
    const q = QUESTIONS[s.step];
    let val;

    if (q.key === 'day_type') {
      val = DAY_MAP[body];
      if (!val) { await sendWhatsApp(from, 'Antwoord met 1, 2 of 3 👆'); return; }
    } else if (q.key === 'pain_location') {
      val = body;
    } else {
      val = parseInt(body);
      if (isNaN(val)) { await sendWhatsApp(from, 'Geef een getal in 👆'); return; }
      const limits = { rpe:[1,10], sleep:[1,5], fatigue:[1,5], pain_score:[0,10] };
      const [min, max] = limits[q.key];
      if (val < min || val > max) { await sendWhatsApp(from, `Getal tussen ${min} en ${max} 👆`); return; }
    }

    s.answers[q.key] = val;
    s.step++;
    if (q.key === 'pain_score' && val === 0) { s.answers.pain_location = 'geen'; s.step++; }

    if (s.step < QUESTIONS.length) { await sendWhatsApp(from, QUESTIONS[s.step].text); return; }

    const a = s.answers;
    delete sessions[phone];

    const dailyLoad = calcDailyLoad(a.day_type, a.rpe || 0);
    const { acute, chronic28, acwr, prevLoad } = await calcACWR(s.userId, dailyLoad);
    const { score, color } = calcRiskScore({ dailyLoad, sleep: a.sleep, fatigue: a.fatigue, painScore: a.pain_score, acwr, prevLoad });

    await getSupabase().from('daily_logs').insert({
      user_id: s.userId,
      date: new Date().toISOString().split('T')[0],
      day_type: a.day_type, rpe: a.rpe || 0, sleep: a.sleep, fatigue: a.fatigue,
      pain_location: a.pain_location, pain_score: a.pain_score, daily_load: dailyLoad,
      acute_7d: acute, chronic_28d_avg: chronic28, acwr: Math.round(acwr * 100) / 100,
      risk_color: color, risk_score: score
    });

    const emoji = { groen:'🟢', geel:'🟡', rood:'🔴' }[color];
    const [playerMsg, parentMsg] = await Promise.all([
      generateMessage(`Kort motiverend WhatsApp-bericht voor jeugdvoetballer ${s.user.child_name} (${s.user.age} jaar). Risico: ${color} ${emoji}. ACWR: ${acwr.toFixed(2)}. Pijn: ${a.pain_score}/10 op ${a.pain_location}. Max 3 zinnen. Sportief. Sluit af met: "${DISCLAIMER}"`),
      generateMessage(`WhatsApp-bericht voor ouder van ${s.user.child_name} (${s.user.age} jaar). Risico: ${color} ${emoji}. ACWR: ${acwr.toFixed(2)}. Belasting: ${dailyLoad.toFixed(1)}. Slaap: ${a.sleep}/5. Vermoeidheid: ${a.fatigue}/5. Pijn: ${a.pain_score}/10 op ${a.pain_location}. Leg risicokleur uit + 1 actietip. Max 5 zinnen. Sluit af met: "${DISCLAIMER}"`)
    ]);

    await sendWhatsApp(`whatsapp:${s.user.child_phone}`, playerMsg);
    if (s.user.parent_phone) await sendWhatsApp(`whatsapp:${s.user.parent_phone}`, parentMsg);

  } catch (err) { console.error('webhook error:', err.message); }
});

app.post('/register', async (req, res) => {
  try {
    const { parent_name, child_name, age, club, position, child_phone, parent_phone } = req.body;
    if (!child_name || !child_phone) return res.status(400).json({ error: 'child_name and child_phone required' });

    const { data, error } = await getSupabase().from('users')
      .insert({ parent_name, child_name, age, club, position, child_phone, parent_phone, active: true })
      .select().single();

    if (error) return res.status(500).json({ error: error.message });

    await sendWhatsApp(`whatsapp:${child_phone}`, `Welkom bij Injury Radar ${child_name}! 🏥⚽\n\nJe ontvangt elke ochtend om 07:30 een check-in vraag.\n\n${DISCLAIMER}`);
    if (parent_phone) await sendWhatsApp(`whatsapp:${parent_phone}`, `Welkom bij Injury Radar! 🏥\n\n${child_name} is geregistreerd. Je ontvangt dagelijks een update.\n\n${DISCLAIMER}`);

    res.json({ success: true, user: data });
  } catch (err) { console.error('register error:', err.message); res.status(500).json({ error: err.message }); }
});

app.get('/monthly-report/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    const now = new Date();
    const firstDay = new Date(now.getFullYear(), now.getMonth() - 1, 1).toISOString().split('T')[0];
    const lastDay = new Date(now.getFullYear(), now.getMonth(), 0).toISOString().split('T')[0];

    const [{ data: user }, { data: logs }] = await Promise.all([
      getSupabase().from('users').select('*').eq('id', userId).single(),
      getSupabase().from('daily_logs').select('*').eq('user_id', userId).gte('date', firstDay).lte('date', lastDay).order('date')
    ]);

    if (!user) return res.status(404).json({ error: 'user not found' });
    if (!logs?.length) return res.status(404).json({ error: 'no data for last month' });

    const red = logs.filter(l => l.risk_color === 'rood').length;
    const yellow = logs.filter(l => l.risk_color === 'geel').length;
    const green = logs.filter(l => l.risk_color === 'groen').length;
    const avgACWR = (logs.reduce((s, l) => s + (l.acwr || 0), 0) / logs.length).toFixed(2);
    const avgSleep = (logs.reduce((s, l) => s + (l.sleep || 0), 0) / logs.length).toFixed(1);

    const report = await generateMessage(`Maandelijks blessurerisico rapport voor ouder van ${user.child_name} (${user.age} jaar, ${user.club || 'club onbekend'}). Periode: ${firstDay} tot ${lastDay}. Check-ins: ${logs.length}. Rood: ${red}. Geel: ${yellow}. Groen: ${green}. Gem. ACWR: ${avgACWR}. Gem. slaap: ${avgSleep}/5. Geef overzicht + 3 concrete aanbevelingen. Sluit af met disclaimer geen medisch advies BVBA Revarchi.`);

    if (user.parent_phone) await sendWhatsApp(`whatsapp:${user.parent_phone}`, `📊 Maandrapport ${user.child_name}\n\n${report}`);
    if (user.child_phone) {
      const short = await generateMessage(`Vat dit rapport samen in max 3 zinnen voor speler (${user.age} jaar, sportieve toon):\n${report}`);
      await sendWhatsApp(`whatsapp:${user.child_phone}`, `📊 Jouw maandoverzicht!\n\n${short}\n\n${DISCLAIMER}`);
    }
    res.json({ success: true, report });
  } catch (err) { console.error('report error:', err.message); res.status(500).json({ error: err.message }); }
});

cron.schedule('30 5 * * *', async () => {
  try {
    const { data: users } = await getSupabase().from('users').select('child_phone, child_name').eq('active', true);
    for (const u of users || []) {
      if (!u.child_phone) continue;
      try { await sendWhatsApp(`whatsapp:${u.child_phone}`, QUESTIONS[0].text); } catch (e) { console.error(e.message); }
      await new Promise(r => setTimeout(r, 300));
    }
  } catch (e) { console.error('cron error:', e.message); }
}, { timezone: 'Europe/Brussels' });

app.get('/health', (_, res) => res.json({ status: 'ok', time: new Date().toISOString() }));

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`Injury Radar running on port ${PORT}`));
