/**
 * Lía — IA de conversação do Frase a Frase.
 * Cloudflare Worker que guarda a chave da OpenAI e conversa com o app.
 *
 * Configuração no Cloudflare (Settings > Variables and Secrets):
 *   OPENAI_API_KEY  (Secret)  chave da OpenAI — obrigatória
 *   MODEL           (Text)    opcional; padrão gpt-5-mini
 *   ALLOWED_ORIGINS (Text)    opcional; padrão https://pedrojr1430.github.io
 *   TTS_MODEL       (Text)    opcional; modelo de voz, padrão gpt-4o-mini-tts
 *   LIA_VOICE       (Text)    opcional; voz da Lía, padrão coral
 *   CONTENT_VOICE   (Text)    opcional; voz das frases, textos e curso, padrão nova
 *
 * Rotas:
 *   POST /           conversa com a Lía (e voz da Lía com {tts})
 *   GET  /voz?t=&a=  voz natural das frases do app (a=es Espanha, a=mx México).
 *                    Só gera áudio para frases que existem no conteúdo publicado do app.
 */

const CONTENT_BASE = 'https://pedrojr1430.github.io/frase-a-frase/data/';
let allowCache = { at: 0, set: null };
function normText(s) { return String(s || '').replace(/[«»]/g, '').replace(/\s+/g, ' ').trim(); }
async function allowedTexts() {
  if (allowCache.set && Date.now() - allowCache.at < 10 * 60 * 1000) return allowCache.set;
  const set = new Set();
  const add = (s) => { if (typeof s === 'string' && s.trim()) set.add(normText(s)); };
  const get = (f) => fetch(CONTENT_BASE + f + '?v=' + Math.floor(Date.now() / 600000)).then((r) => (r.ok ? r.json() : null)).catch(() => null);
  const [fr, tx, cu] = await Promise.all([get('frases.json'), get('textos.json'), get('curso.json')]);
  (fr || []).forEach((c) => (c.items || []).forEach((i) => add(i.es)));
  (tx || []).forEach((t) => (t.sentences || []).forEach((p) => add(p[0])));
  (function walk(v) { if (typeof v === 'string') add(v); else if (Array.isArray(v)) v.forEach(walk); else if (v && typeof v === 'object') Object.values(v).forEach(walk); })(cu);
  allowCache = { at: Date.now(), set };
  return set;
}
const ACCENT = {
  es: 'Leia em espanhol da Espanha (castelhano), com pronúncia peninsular natural.',
  mx: 'Leia em espanhol do México, com pronúncia mexicana natural.'
};

const VOICE_STYLE = {
  A1: 'Fale bem devagar e com pausas claras entre as frases, articulando cada palavra.',
  A2: 'Fale devagar e com clareza.',
  B1: 'Fale em ritmo natural, mas claro.',
  B2: 'Fale em ritmo natural de conversa.'
};

const SCENARIOS = {
  livre: 'Conversa livre sobre o dia a dia do aluno: rotina, família, trabalho, gostos e planos.',
  apresentar: 'O aluno acabou de conhecer você numa festa. Pergunte nome, de onde é, o que faz e do que gosta.',
  cafe: 'Você é atendente de um café em Madri. O aluno quer pedir algo para comer e beber e depois pagar.',
  hotel: 'Você é recepcionista de um hotel em Buenos Aires. O aluno chega para fazer check-in e tem perguntas sobre o quarto e o café da manhã.',
  caminho: 'Você é uma pessoa na rua na Cidade do México. O aluno está perdido e pede direções para chegar a um museu.',
  entrevista: 'Você é recrutador numa entrevista de emprego em Bogotá. Faça perguntas sobre experiência, pontos fortes e objetivos do aluno.'
};

const LEVELS = {
  A1: 'A1 (iniciante): frases muito curtas (até 10 palavras), vocabulário básico, só presente do indicativo. Fale devagar e com palavras frequentes.',
  A2: 'A2 (básico): frases curtas, presente, pretérito perfeito e indefinido, futuro com "ir a". Vocabulário do cotidiano.',
  B1: 'B1 (intermediário): frases naturais, todos os tempos do indicativo e subjuntivo presente simples. Pode usar expressões comuns.',
  B2: 'B2 (avançado): espanhol natural e variado, com expressões idiomáticas e subjuntivo.'
};

function systemPrompt(level, scenario) {
  return [
    'Você é Lía, a tutora de conversação do app Frase a Frase, que ensina espanhol para brasileiros.',
    'Você é uma inteligência artificial: nunca diga ou finja que é humana.',
    'Identidade: você é a Lía, a IA do Frase a Frase. Não cite empresas nem nomes de modelos de IA. Se perguntarem se você é o ChatGPT ou outra IA específica, não confirme nem negue: diga que é a Lía, a IA do Frase a Frase, e que funciona com modelos de linguagem de parceiros. Nunca afirme que não usa tecnologia de terceiros.',
    'Nível do aluno: ' + LEVELS[level],
    'Cenário: ' + SCENARIOS[scenario],
    'Regras:',
    '- Escreva "reply" SEMPRE em espanhol neutro, no nível do aluno, em no máximo 2 ou 3 frases curtas, e termine com uma pergunta para manter a conversa.',
    '- Se a última mensagem do aluno tiver erro de espanhol, preencha "correction" em português, curto: a forma certa entre aspas e uma explicação de uma frase. Se não houver erro, deixe "correction" vazio.',
    '- Se o aluno escrever em português, responda em espanhol simples e mostre em "correction" como dizer a mensagem dele em espanhol.',
    '- "suggestions": duas respostas curtas e diferentes que o aluno poderia dar agora, em espanhol, no nível dele.',
    '- Elogie progressos de vez em quando, com naturalidade.',
    '- Assuntos impróprios ou fora do aprendizado: recuse com gentileza, em espanhol simples, e volte ao cenário.',
    'Responda somente com JSON válido no formato {"reply": "...", "correction": "...", "suggestions": ["...", "..."]}.'
  ].join('\n');
}

// Voz natural para o conteúdo do app, com cache.
async function voz(req, url, env, ctx) {
  const h = { 'Access-Control-Allow-Origin': '*', 'Vary': 'Origin' };
  const text = normText(url.searchParams.get('t'));
  const acc = url.searchParams.get('a') === 'mx' ? 'mx' : 'es';
  if (!text || text.length > 400) return new Response('bad request', { status: 400, headers: h });
  const key = new Request(url.origin + '/voz?v=1&a=' + acc + '&t=' + encodeURIComponent(text));
  const cache = caches.default;
  try { const hit = await cache.match(key); if (hit) return hit; } catch (e) {}
  const set = await allowedTexts();
  if (!set.has(text)) return new Response('not allowed', { status: 403, headers: h });
  if (limited('voz:' + (req.headers.get('CF-Connecting-IP') || 'x'), 400)) return new Response('rate limited', { status: 429, headers: h });
  const apiKey = env.OPENAI_API_KEY || Object.values(env).find((v) => typeof v === 'string' && /^sk-/.test(v));
  if (!apiKey) return new Response('not configured', { status: 500, headers: h });
  const tr = await fetch('https://api.openai.com/v1/audio/speech', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + apiKey },
    body: JSON.stringify({
      model: env.TTS_MODEL || 'gpt-4o-mini-tts',
      voice: env.CONTENT_VOICE || 'nova',
      input: text,
      instructions: 'Você é um professor nativo gravando áudios para um curso de espanhol. ' + ACCENT[acc] + ' Fale de forma natural e calorosa, com entonação de conversa real, articulação clara e ritmo um pouco mais pausado que o normal. Respeite a pontuação: perguntas com entonação de pergunta, exclamações com emoção.',
      response_format: 'mp3'
    })
  });
  if (!tr.ok) { console.log('OpenAI voz', tr.status, (await tr.text()).slice(0, 300)); return new Response('tts failed', { status: 502, headers: h }); }
  const buf = await tr.arrayBuffer();
  const resp = new Response(buf, { headers: { ...h, 'Content-Type': 'audio/mpeg', 'Cache-Control': 'public, max-age=31536000, immutable' } });
  try { ctx.waitUntil(cache.put(key, resp.clone())); } catch (e) {}
  return resp;
}

// Limite simples por IP (por instância do Worker): 30 mensagens a cada 10 minutos.
const hits = new Map();
function limited(ip, max) {
  const now = Date.now(), win = 10 * 60 * 1000;
  const list = (hits.get(ip) || []).filter((t) => now - t < win);
  list.push(now); hits.set(ip, list);
  return list.length > (max || 30);
}

export default {
  async fetch(req, env, ctx) {
    const allowed = (env.ALLOWED_ORIGINS || 'https://pedrojr1430.github.io').split(',').map((s) => s.trim());
    const origin = req.headers.get('Origin') || '';
    const cors = {
      'Access-Control-Allow-Origin': allowed.includes(origin) ? origin : allowed[0],
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Vary': 'Origin'
    };
    const json = (obj, status) => new Response(JSON.stringify(obj), { status: status || 200, headers: { ...cors, 'Content-Type': 'application/json; charset=utf-8' } });

    if (req.method === 'OPTIONS') return new Response(null, { headers: cors });
    const url = new URL(req.url);
    if (req.method === 'GET' && url.pathname === '/voz') return voz(req, url, env, ctx);
    if (req.method === 'GET') return json({ ok: true, name: 'Lía' });
    if (req.method !== 'POST' || !allowed.includes(origin)) return json({ error: 'forbidden' }, 403);
    // Aceita o Secret com o nome OPENAI_API_KEY ou, se tiver outro nome, qualquer Secret com uma chave da OpenAI.
    const apiKey = env.OPENAI_API_KEY || Object.values(env).find((v) => typeof v === 'string' && /^sk-/.test(v));
    if (!apiKey) return json({ error: 'not_configured' }, 500);
    if (limited(req.headers.get('CF-Connecting-IP') || 'x')) return json({ error: 'rate_limited' }, 429);

    let body;
    try { body = await req.json(); } catch (e) { return json({ error: 'bad_request' }, 400); }
    const level = LEVELS[body.level] ? body.level : 'A1';

    // Voz da Lía: transforma o texto da resposta em áudio (mp3).
    if (typeof body.tts === 'string') {
      const input = body.tts.trim().slice(0, 600);
      if (!input) return json({ error: 'bad_request' }, 400);
      const tr = await fetch('https://api.openai.com/v1/audio/speech', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + apiKey },
        body: JSON.stringify({
          model: env.TTS_MODEL || 'gpt-4o-mini-tts',
          voice: env.LIA_VOICE || 'coral',
          input,
          instructions: 'Você é a Lía, professora de espanhol simpática e acolhedora. Fale em espanhol latino-americano neutro, com voz calorosa, sorridente e encorajadora. ' + VOICE_STYLE[level],
          response_format: 'mp3'
        })
      });
      if (!tr.ok) {
        console.log('OpenAI TTS', tr.status, (await tr.text()).slice(0, 300));
        return json({ error: 'tts_failed', status: tr.status }, 502);
      }
      return new Response(tr.body, { headers: { ...cors, 'Content-Type': 'audio/mpeg', 'Cache-Control': 'no-store' } });
    }
    const scenario = SCENARIOS[body.scenario] ? body.scenario : 'livre';
    const history = (Array.isArray(body.messages) ? body.messages : [])
      .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
      .slice(-12)
      .map((m) => ({ role: m.role, content: m.content.slice(0, 600) }));
    if (!history.length) history.push({ role: 'user', content: '(Início da conversa. Cumprimente o aluno e comece o cenário com uma pergunta simples.)' });

    const model = env.MODEL || 'gpt-5-mini';
    const payload = {
      model,
      messages: [{ role: 'system', content: systemPrompt(level, scenario) }, ...history],
      response_format: { type: 'json_object' },
      max_completion_tokens: 700
    };
    if (/^gpt-5/.test(model)) payload.reasoning_effort = 'minimal';

    const r = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + apiKey },
      body: JSON.stringify(payload)
    });
    if (!r.ok) {
      console.log('OpenAI', r.status, (await r.text()).slice(0, 300)); // detalhe só no log do Cloudflare
      return json({ error: r.status === 401 ? 'bad_key' : r.status === 429 ? 'quota' : 'upstream', status: r.status }, 502);
    }
    const data = await r.json();
    const text = (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || '';
    let out;
    try { out = JSON.parse(text); } catch (e) { out = { reply: text, correction: '', suggestions: [] }; }
    return json({
      reply: String(out.reply || '').slice(0, 800),
      correction: String(out.correction || '').slice(0, 500),
      suggestions: (Array.isArray(out.suggestions) ? out.suggestions : []).slice(0, 2).map((s) => String(s).slice(0, 120))
    });
  }
};
