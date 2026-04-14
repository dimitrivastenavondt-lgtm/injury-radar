const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const Anthropic = require('@anthropic-ai/sdk');
const twilio = require('twilio');
const cron = require('node-cron');

const app = express();
app.use((req, res, next) => { res.header("Access-Control-Allow-Origin", "*"); res.header("Access-Control-Allow-Headers", "Content-Type"); res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS"); if (req.method === "OPTIONS") return res.sendStatus(200); next(); });
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ── Clients ──────────────────────────────────────────────────────────────────
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
const TWILIO_FROM = `whatsapp:${process.env.TWILIO_WHATSAPP_NUMBER}`;
const DISCLAIMER_SHORT = '⚠️ Dit is geen medisch advies. Bij pijn of twijfel, raadpleeg een arts of kinesist.';

// ── Risk calculation ──────────────────────────────────────────────────────────
function calcDailyLoad(dayType, rpe) {
  if (dayType === 'rust') return 0;
  if (dayType === 'wedstrijd') return rpe * 1.5;
  return rpe * 1;
}

function calcRiskScore({ dailyLoad, sleep, fatigue, painScore, acwr, prevLoad }) {
  let score = 0;
  if (dailyLoad > 7) score += 2;
  if (prevLoad > 7) score += 2;           // 2 heavy days in a row
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
  const { data } = await supabase
    .from('daily_logs')
    .select('daily_load, date')
    .eq('user_id', userId)
    .order('date', { ascending: false })
    .limit(28);

  const loads = data ? data.map(r => r.daily_load) : [];
  // Prepend today
  const all = [todayLoad, ...loads];
  const acute = all.slice(0, 7).reduce((s, v) => s + v, 0);
  const chronic28 = all.slice(0, 28).reduce((s, v) => s + v, 0) / Math.min(all.length, 28);
  const acwr = chronic28 > 0 ? acute / chronic28 : 0;
  const prevLoad = loads[0] ?? 0;
  return { acute, chronic28, acwr, prevLoad };
}

// ── AI message generation ────────────────────────────────────────────────────
async function generateMessage(prompt) {
  const msg = await anthropic.messages.create({
    model: 'claude-opus-4-5',
    max_tokens: 300,
    messages: [{ role: 'user', content: prompt }]
  });
  return msg.content[0].text.trim();
}

async function sendWhatsApp(to, body) {
  if (!to) return;
  const num = to.startsWith('whatsapp:') ? to : `whatsapp:${to}`;
  await twilioClient.messages.create({ from: TWILIO_FROM, to: num, body });
}

// ── Conversation state (in-memory, keyed by phone number) ────────────────────
const sessions = {};

const QUESTIONS = [
  { key: 'day_type', text: 'Goedemorgen! 👋\nWat was je dag vandaag?\n1️⃣ Rust\n2️⃣ Training\n3️⃣ Wedstrijd\n\nAntwoord met 1, 2 of 3.' },
  { key: 'rpe', text: 'Hoe zwaar was de inspanning? (RPE)\nSchaal 1–10 👇' },
  { key: 'sleep', text: 'Hoe goed heb je geslapen?\n1 = slecht, 5 = uitstekend 💤' },
  { key: 'fatigue', text: 'Hoe vermoeid voel je je nu?\n1 = fris, 5 = uitgeput 🔋' },
  { key: 'pain_score', text: 'Heb je ergens pijn?\n0 = geen pijn, 10 = hevige pijn 🤕' },
  { key: 'pain_location', text: 'Waar heb je pijn? (beschrijf kort, bv. "linkerknie", "enkel" of "geen")' }
];

const DAY_TYPE_MAP = { '1': 'rust', '2': 'training', '3': 'wedstrijd' };

// ── Webhook: incoming WhatsApp ────────────────────────────────────────────────
app.post('/webhook/whatsapp', async (req, res) => {
  res.sendStatus(200); // ACK Twilio immediately
  const from = req.body.From;
  const body = (req.body.Body || '').trim();
  const phone = from.replace('whatsapp:', '');

  try {
    // Look up user by child_phone or parent_phone
    const { data: users } = await supabase
      .from('users')
      .select('*')
      .or(`child_phone.eq.${phone},parent_phone.eq.${phone}`)
      .limit(1);

    const user = users?.[0];

    // Onboarding if unknown number
    if (!user) {
      await sendWhatsApp(from,
        'Welkom bij Injury Radar 🏥⚽\n\nJe nummer is nog niet geregistreerd.\nVraag je ouder of coach om je in te schrijven via de app.\n\n' + DISCLAIMER_SHORT
      );
      return;
    }

    const isPlayer = user.child_phone === phone;
    const session = sessions[phone] || { step: 0, answers: {} };

    // Start check-in if no session active — only from player
    if (!sessions[phone] && isPlayer) {
      sessions[phone] = { step: 0, answers: {}, userId: user.id, user };
      await sendWhatsApp(from, QUESTIONS[0].text);
      return;
    }

    if (!sessions[phone]) {
      await sendWhatsApp(from, 'Check-ins worden gestart door de speler 👟');
      return;
    }

    const s = sessions[phone];
    const q = QUESTIONS[s.step];

    // Validate & store answer
    let val;
    if (q.key === 'day_type') {
      val = DAY_TYPE_MAP[body];
      if (!val) { await sendWhatsApp(from, 'Antwoord met 1, 2 of 3 👆'); return; }
    } else if (q.key === 'pain_location') {
      val = body;
    } else {
      val = parseInt(body);
      if (isNaN(val)) { await sendWhatsApp(from, 'Geef een getal in 👆'); return; }
      const limits = { rpe: [1,10], sleep: [1,5], fatigue: [1,5], pain_score: [0,10] };
      const [min, max] = limits[q.key];
      if (val < min || val > max) { await sendWhatsApp(from, `Getal tussen ${min} en ${max} 👆`); return; }
    }

    s.answers[q.key] = val;
    s.step++;

    // Skip pain_location if no pain
    if (q.key === 'pain_score' && val === 0) {
      s.answers.pain_location = 'geen';
      s.step++;
    }

    if (s.step < QUESTIONS.length) {
      await sendWhatsApp(from, QUESTIONS[s.step].text);
      return;
    }

    // All answers collected — process
    const a = s.answers;
    delete sessions[phone];

    const dailyLoad = calcDailyLoad(a.day_type, a.rpe || 0);
    const { acute, chronic28, acwr, prevLoad } = await calcACWR(s.userId, dailyLoad);
    const { score, color } = calcRiskScore({
      dailyLoad, sleep: a.sleep, fatigue: a.fatigue,
      painScore: a.pain_score, acwr, prevLoad
    });

    // Save to DB
    await supabase.from('daily_logs').insert({
      user_id: s.userId,
      date: new Date().toISOString().split('T')[0],
      day_type: a.day_type,
      rpe: a.rpe || 0,
      sleep: a.sleep,
      fatigue: a.fatigue,
      pain_location: a.pain_location,
      pain_score: a.pain_score,
      daily_load: dailyLoad,
      acute_7d: acute,
      chronic_28d_avg: chronic28,
      acwr: Math.round(acwr * 100) / 100,
      risk_color: color,
      risk_score: score
    });

    const colorEmoji = { groen: '🟢', geel: '🟡', rood: '🔴' }[color];

    // Message to player
    const playerPrompt = `Schrijf een korte motiverende WhatsApp-bericht voor een jeugdvoetballer (leeftijd: ${s.user.age}).
Risico: ${color} ${colorEmoji}. ACWR: ${acwr.toFixed(2)}. Pijn: ${a.pain_score}/10 op ${a.pain_location}.
Toon: direct, sportief, leeftijdspassend. Max 3 zinnen. Sluit af met: "${DISCLAIMER_SHORT}"
Schrijf alleen het bericht, geen uitleg.`;

    // Message to parent
    const parentPrompt = `Schrijf een duidelijk WhatsApp-bericht voor een ouder over het dagelijkse blessurerisico van hun kind.
Kind: ${s.user.child_name}, ${s.user.age} jaar. Risico: ${color} ${colorEmoji}. ACWR: ${acwr.toFixed(2)}.
Belasting: ${dailyLoad.toFixed(1)}. Slaap: ${a.sleep}/5. Vermoeidheid: ${a.fatigue}/5. Pijn: ${a.pain_score}/10 op ${a.pain_location}.
Leg uit wat de risicokleur betekent en geef 1 concrete actietip. Max 5 zinnen. Sluit af met: "${DISCLAIMER_SHORT}"
Schrijf alleen het bericht, geen uitleg.`;

    const [playerMsg, parentMsg] = await Promise.all([
      generateMessage(playerPrompt),
      generateMessage(parentPrompt)
    ]);

    await sendWhatsApp(`whatsapp:${s.user.child_phone}`, playerMsg);
    if (s.user.parent_phone) {
      await sendWhatsApp(`whatsapp:${s.user.parent_phone}`, parentMsg);
    }

  } catch (err) {
    console.error('webhook error:', err.message);
  }
});

// ── Daily trigger: send morning check-in to all active players ────────────────
async function sendDailyCheckins() {
  const { data: users } = await supabase
    .from('users')
    .select('child_phone, child_name')
    .eq('active', true);

  if (!users?.length) return;

  for (const u of users) {
    if (!u.child_phone) continue;
    try {
      await sendWhatsApp(`whatsapp:${u.child_phone}`, QUESTIONS[0].text);
      await new Promise(r => setTimeout(r, 200)); // rate limit buffer
    } catch (e) {
      console.error(`Failed to send to ${u.child_name}:`, e.message);
    }
  }
}

// Every day at 07:30 Brussels time (UTC+2 → 05:30 UTC)
cron.schedule('30 5 * * *', sendDailyCheckins, { timezone: 'Europe/Brussels' });

// ── Register user ─────────────────────────────────────────────────────────────
app.post('/register', async (req, res) => {
  const { parent_name, child_name, age, club, position, child_phone, parent_phone } = req.body;
  if (!child_name || !child_phone) return res.status(400).json({ error: 'child_name and child_phone required' });

  const { data, error } = await supabase.from('users').insert({
    parent_name, child_name, age, club, position,
    child_phone, parent_phone, active: true
  }).select().single();

  if (error) return res.status(500).json({ error: error.message });

  // Welcome message to player
  await sendWhatsApp(`whatsapp:${child_phone}`,
    `Welkom bij Injury Radar ${child_name}! 🏥⚽\n\nJe ontvangt elke ochtend om 07:30 een check-in vraag.\nBeantwoord de vragen eerlijk — dit helpt jou geblesseerd te blijven! 💪\n\n${DISCLAIMER_SHORT}`
  );

  if (parent_phone) {
    await sendWhatsApp(`whatsapp:${parent_phone}`,
      `Welkom bij Injury Radar! 🏥\n\n${child_name} is geregistreerd. Je ontvangt dagelijks een update over zijn/haar belasting en herstelstatus.\n\n${DISCLAIMER_SHORT}`
    );
  }

  res.json({ success: true, user: data });
});

// ── Monthly report endpoint ───────────────────────────────────────────────────
app.get('/monthly-report/:userId', async (req, res) => {
  const { userId } = req.params;
  const now = new Date();
  const firstDay = new Date(now.getFullYear(), now.getMonth() - 1, 1).toISOString().split('T')[0];
  const lastDay = new Date(now.getFullYear(), now.getMonth(), 0).toISOString().split('T')[0];

  const [{ data: user }, { data: logs }] = await Promise.all([
    supabase.from('users').select('*').eq('id', userId).single(),
    supabase.from('daily_logs').select('*').eq('user_id', userId).gte('date', firstDay).lte('date', lastDay).order('date')
  ]);

  if (!user) return res.status(404).json({ error: 'user not found' });
  if (!logs?.length) return res.status(404).json({ error: 'no data for last month' });

  const red = logs.filter(l => l.risk_color === 'rood').length;
  const yellow = logs.filter(l => l.risk_color === 'geel').length;
  const green = logs.filter(l => l.risk_color === 'groen').length;
  const avgACWR = (logs.reduce((s, l) => s + (l.acwr || 0), 0) / logs.length).toFixed(2);
  const avgSleep = (logs.reduce((s, l) => s + (l.sleep || 0), 0) / logs.length).toFixed(1);

  const summary = `Speler: ${user.child_name}, ${user.age} jaar, ${user.club || 'onbekende club'}.
Periode: ${firstDay} tot ${lastDay}. Aantal check-ins: ${logs.length}.
Rode dagen: ${red}. Gele dagen: ${yellow}. Groene dagen: ${green}.
Gemiddelde ACWR: ${avgACWR}. Gemiddelde slaapscore: ${avgSleep}/5.`;

  const reportPrompt = `Schrijf een maandelijks blessurerisico rapport in het Nederlands voor de ouder van een jeugdvoetballer.
${summary}
Geef een overzicht, 3 concrete aanbevelingen en een motiverende afsluiting.
Sluit altijd af met de volledige disclaimer: "⚠️ GEEN MEDISCH ADVIES: Dit rapport is uitsluitend informatief en gebaseerd op door de gebruiker ingevoerde gegevens. Het vervangt geen professioneel medisch of kinesitherapeutisch advies. Bij klachten, raadpleeg altijd een arts of erkend kinesitherapeut. BVBA Revarchi / Injury Radar kan niet aansprakelijk worden gesteld voor beslissingen genomen op basis van dit rapport."`;

  const report = await generateMessage(reportPrompt);

  // Send to parent and player
  if (user.parent_phone) await sendWhatsApp(`whatsapp:${user.parent_phone}`, `📊 Maandrapport ${child_name}\n\n${report}`);

  const shortPrompt = `Schrijf een korte samenvatting (max 3 zinnen) van dit maandrapport voor de speler zelf (${user.age} jaar, sportief en direct):\n${report}`;
  const shortReport = await generateMessage(shortPrompt);
  if (user.child_phone) await sendWhatsApp(`whatsapp:${user.child_phone}`, `📊 Jouw maandoverzicht!\n\n${shortReport}\n\n${DISCLAIMER_SHORT}`);

  res.json({ success: true, summary, report });
});

// ── Health check ──────────────────────────────────────────────────────────────
app.get('/health', (_, res) => res.json({ status: 'ok', time: new Date().toISOString() }));

// ── Start ─────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`Injury Radar running on port ${PORT}`));
