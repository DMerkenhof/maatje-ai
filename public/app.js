import { marked } from '/vendor/marked.js';
import DOMPurify from '/vendor/purify.js';

marked.use({ gfm: true, breaks: false });
DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (node.tagName === 'A') {
    node.setAttribute('target', '_blank');
    node.setAttribute('rel', 'noopener noreferrer');
  }
});

const $ = (id) => document.getElementById(id);
const el = {
  app: document.querySelector('.app'),
  chatList: $('chatList'),
  newChat: $('newChat'),
  menuBtn: $('menuBtn'),
  scrim: $('scrim'),
  title: $('chatTitle'),
  modelBtn: $('modelBtn'),
  modelLabel: $('modelLabel'),
  effortSel: $('effortSel'),
  messages: $('messages'),
  composer: $('composer'),
  input: $('input'),
  sendBtn: $('sendBtn'),
  picker: $('picker'),
  modelSearch: $('modelSearch'),
  modelList: $('modelList'),
  pickerClose: $('pickerClose'),
  memoryBtn: $('memoryBtn'),
  memoryBadge: $('memoryBadge'),
  memorySheet: $('memorySheet'),
  memBack: $('memBack'),
  memTitle: $('memTitle'),
  memClose: $('memClose'),
  memBody: $('memBody'),
  skillsBtn: $('skillsBtn'),
  skillSheet: $('skillSheet'),
  skillBack: $('skillBack'),
  skillTitle: $('skillTitle'),
  skillClose: $('skillClose'),
  skillBody: $('skillBody'),
  skillFile: $('skillFile'),
  slashMenu: $('slashMenu'),
  mcpBtn: $('mcpBtn'),
  logoutBtn: $('logoutBtn'),
  login: $('login'),
  loginForm: $('loginForm'),
  loginPassword: $('loginPassword'),
  loginMsg: $('loginMsg'),
  mcpBadge: $('mcpBadge'),
  mcpSheet: $('mcpSheet'),
  mcpBack: $('mcpBack'),
  mcpTitle: $('mcpTitle'),
  mcpClose: $('mcpClose'),
  mcpBody: $('mcpBody'),
};

const state = {
  chats: [],
  chat: null,         // huidige chat, null = nieuwe chat die nog niet bestaat
  messages: [],
  model: null,        // gekozen model voor het volgende bericht
  effort: 'default',  // hoe hard het model mag nadenken ('default' = wat het model zelf kiest)
  models: [],         // OpenRouter-modellen
  modelsError: null,
  local: { status: 'off', name: 'Mac', models: [] }, // modellen op je eigen computer
  favorites: [],
  settings: {},
  streaming: false,
  streamCtl: null,    // AbortController van de lopende fetch (alleen de browserkant)
  pendingSend: null,  // tekst die wacht tot er een model gekozen is
  pickerMode: 'chat', // 'chat' of 'memory' (model kiezen dat de memory bijwerkt)
  memory: null,       // laatst opgehaalde memory-overzicht
  mcp: null,          // laatst opgehaalde MCP-servers
  skills: [],         // skills, ook voor de /-suggesties
};

const touch = window.matchMedia('(pointer: coarse)').matches;

// ---------- API ----------

async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (res.status === 401 && json.auth) showLogin();
  if (!res.ok) throw new Error(json.error || `Fout ${res.status}`);
  return json;
}

// ---------- Inloggen ----------

function showLogin() {
  if (!el.login.hidden) return;
  el.login.hidden = false;
  setTimeout(() => el.loginPassword.focus(), 30);
}

el.loginForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  el.loginMsg.textContent = '';
  try {
    const res = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: el.loginPassword.value }),
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(j.error || `Fout ${res.status}`);
    location.reload();
  } catch (err) {
    el.loginMsg.textContent = err.message;
    el.loginPassword.select();
  }
});

el.logoutBtn.addEventListener('click', async () => {
  try { await fetch('/api/logout', { method: 'POST' }); } catch {}
  location.reload();
});

// ---------- Opstarten ----------

async function init() {
  const a = await api('GET', '/api/auth');
  el.logoutBtn.hidden = !a.enabled;
  if (a.enabled && !a.loggedIn) {
    showLogin();
    return;
  }
  const [settings, chats] = await Promise.all([api('GET', '/api/settings'), api('GET', '/api/chats')]);
  state.settings = settings;
  state.favorites = settings.favorites || [];
  state.chats = chats.chats;
  loadModels();
  refreshMemoryBadge();
  refreshMcp();
  loadSkills();
  await route();
  window.addEventListener('hashchange', route);
}

async function loadModels(force = false) {
  try {
    const r = await api('GET', '/api/models' + (force ? '?refresh=1' : ''));
    if (r.models.length || !state.models.length) state.models = r.models;
    state.modelsError = r.error || null;
    state.local = r.local || { status: 'off', name: 'Mac', models: [] };
  } catch (err) {
    state.modelsError = err.message;
  }
  renderModelButton();
  if (!state.streaming) renderMessages();
  if (!el.picker.hidden) renderModelList();
}

async function route() {
  const m = location.hash.match(/^#\/c\/([\w-]+)/);
  closeNav();
  if (m) await openChat(m[1]);
  else showNewChat();
}

function defaultModel() {
  return state.settings.lastModel || state.settings.defaultModel || state.favorites[0] || null;
}

function showNewChat() {
  detachStream();
  state.chat = null;
  state.messages = [];
  state.model = state.model || defaultModel();
  render();
  if (!touch) el.input.focus();
}

async function openChat(id) {
  detachStream();
  try {
    const r = await api('GET', `/api/chats/${id}`);
    state.chat = r.chat;
    state.messages = r.messages;
    state.model = r.chat.model || state.model || defaultModel();
    state.effort = r.chat.effort || 'default';
    render();
    scrollToBottom(true);
    if (r.chat.generating) resumeStream(id);
  } catch {
    location.hash = '';
  }
}

// ---------- Versturen en streamen ----------

async function send() {
  const text = el.input.value.trim();
  if (!text || state.streaming) return;
  if (!state.model) {
    state.pendingSend = text;
    openPicker();
    return;
  }

  if (!state.chat) {
    try {
      const r = await api('POST', '/api/chats', { model: state.model });
      state.chat = r.chat;
      state.chats.unshift(r.chat);
      history.replaceState(null, '', `#/c/${r.chat.id}`);
    } catch (err) {
      alert(err.message);
      return;
    }
  }

  el.input.value = '';
  autosize();

  const userMsg = { id: 'tmp-user', role: 'user', content: text };
  const reply = { id: 'tmp-reply', role: 'assistant', content: '', status: 'streaming', model: state.model };
  state.messages.push(userMsg, reply);
  render();
  scrollToBottom(true);

  await runStream(`/api/chats/${state.chat.id}/messages`, { content: text, model: state.model, effort: state.effort }, reply, userMsg);
}

async function regenerate() {
  if (state.streaming || !state.chat) return;
  if (!state.model) { openPicker(); return; }
  const last = state.messages[state.messages.length - 1];
  if (last && last.role === 'assistant') state.messages.pop();
  const reply = { id: 'tmp-reply', role: 'assistant', content: '', status: 'streaming', model: state.model };
  state.messages.push(reply);
  render();
  scrollToBottom(true);
  await runStream(`/api/chats/${state.chat.id}/regenerate`, { model: state.model, effort: state.effort }, reply, null);
}

async function resumeStream(chatId) {
  const reply = state.messages.findLast((m) => m.role === 'assistant' && m.status === 'streaming');
  if (!reply) return;
  await runStream(`/api/chats/${chatId}/stream`, null, reply, null);
}

async function runStream(url, body, reply, userMsg) {
  const chatId = state.chat.id;
  const ctl = new AbortController();
  state.streamCtl = ctl;
  state.streaming = true;
  renderComposer();

  const stillHere = () => state.chat && state.chat.id === chatId && state.streamCtl === ctl;

  try {
    const res = await fetch(url, {
      method: body ? 'POST' : 'GET',
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal: ctl.signal,
    });

    const type = res.headers.get('Content-Type') || '';
    if (!res.ok || !type.includes('ndjson')) {
      const json = await res.json().catch(() => ({}));
      if (res.status === 401 && json.auth) showLogin();
      if (json.generating === false) {
        // Het antwoord was al klaar; gewoon de chat opnieuw laden.
        if (stillHere()) await openChat(chatId);
        return;
      }
      throw new Error(json.error || `Fout ${res.status}`);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let nl;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        if (!line.trim()) continue;
        const ev = JSON.parse(line);
        if (!stillHere()) continue;
        handleEvent(ev, reply, userMsg);
      }
    }
  } catch (err) {
    if (err.name === 'AbortError') return;
    if (stillHere()) {
      // Verbinding weg (bijv. telefoon in slaap). Het antwoord loopt op de
      // server door, dus de chat opnieuw ophalen pakt het weer op.
      if (reply.id !== 'tmp-reply') {
        setTimeout(() => {
          if (state.chat?.id === chatId && !state.streaming) openChat(chatId);
        }, 800);
      } else {
        reply.status = 'error';
        reply.error = err.message;
        renderMessages();
      }
    }
  } finally {
    if (state.streamCtl === ctl) {
      state.streamCtl = null;
      state.streaming = false;
      renderComposer();
    }
  }
}

function handleEvent(ev, reply, userMsg) {
  switch (ev.type) {
    case 'start':
      if (ev.userMessage && userMsg) Object.assign(userMsg, ev.userMessage);
      reply.id = ev.assistantId;
      if (ev.chat) updateChatInList(ev.chat);
      break;
    case 'resume':
      reply.content = ev.content || '';
      reply.thinking = ev.thinking;
      reply.statusText = ev.status || null;
      reply.approval = ev.approval || null;
      reply.liveTools = ev.tools || [];
      renderMessages();
      break;
    case 'status':
      reply.statusText = ev.text;
      scheduleReplyRender(reply);
      break;
    case 'approval':
      reply.approval = ev.approval;
      reply.statusText = 'Wacht op je toestemming…';
      scheduleReplyRender(reply);
      break;
    case 'approval_done':
      if (reply.approval?.id === ev.id) reply.approval = null;
      reply.statusText = null;
      scheduleReplyRender(reply);
      break;
    case 'tool':
      reply.liveTools = [...(reply.liveTools || []), ev.entry];
      break;
    case 'reasoning':
      reply.thinking = true;
      scheduleReplyRender(reply);
      break;
    case 'delta':
      reply.thinking = false;
      reply.statusText = null;
      reply.content += ev.text;
      scheduleReplyRender(reply);
      break;
    case 'done':
      if (ev.message) Object.assign(reply, ev.message);
      reply.thinking = false;
      reply.approval = null;
      if (reply.status === 'streaming') reply.status = 'done';
      bumpChat(state.chat.id);
      renderMessages();
      scrollToBottom();
      setTimeout(refreshMemoryBadge, 1500);
      break;
  }
}

function detachStream() {
  // Alleen de browser stopt met meekijken; de server maakt het antwoord af.
  if (state.streamCtl) state.streamCtl.abort();
  state.streamCtl = null;
  state.streaming = false;
}

async function stop() {
  if (!state.chat) return;
  try { await api('POST', `/api/chats/${state.chat.id}/stop`); } catch {}
}

// ---------- Chats ----------

function updateChatInList(chat) {
  const i = state.chats.findIndex((c) => c.id === chat.id);
  if (i >= 0) state.chats[i] = { ...state.chats[i], ...chat };
  else state.chats.unshift(chat);
  if (state.chat && state.chat.id === chat.id) state.chat = { ...state.chat, ...chat };
  renderChatList();
  renderTitle();
}

function bumpChat(id) {
  const i = state.chats.findIndex((c) => c.id === id);
  if (i < 0) return;
  const [c] = state.chats.splice(i, 1);
  c.updated_at = Date.now();
  c.generating = false;
  state.chats.unshift(c);
  renderChatList();
}

async function renameChat() {
  if (!state.chat) return;
  const title = prompt('Naam van deze chat', state.chat.title);
  if (!title || !title.trim()) return;
  try {
    const r = await api('PATCH', `/api/chats/${state.chat.id}`, { title: title.trim() });
    updateChatInList(r.chat);
  } catch (err) { alert(err.message); }
}

async function deleteChat(id) {
  const chat = state.chats.find((c) => c.id === id);
  if (!confirm(`"${chat?.title || 'Deze chat'}" verwijderen?`)) return;
  try {
    await api('DELETE', `/api/chats/${id}`);
    state.chats = state.chats.filter((c) => c.id !== id);
    if (state.chat && state.chat.id === id) location.hash = '';
    renderChatList();
  } catch (err) { alert(err.message); }
}

// ---------- Modelkiezer ----------

function openPicker(mode = 'chat') {
  state.pickerMode = mode;
  el.picker.hidden = false;
  el.modelSearch.value = '';
  renderModelList();
  // Elke keer verversen: je Mac kan inmiddels aan of uit staan.
  loadModels();
  setTimeout(() => el.modelSearch.focus(), 30);
}

function closePicker() {
  el.picker.hidden = true;
  state.pendingSend = null;
  state.pickerMode = 'chat';
}

async function chooseModel(id) {
  if (state.pickerMode === 'memory') {
    el.picker.hidden = true;
    state.pickerMode = 'chat';
    try { await api('PUT', '/api/settings', { memoryModel: id }); } catch (err) { alert(err.message); }
    await loadMemory();
    return;
  }
  state.model = id;
  const pending = state.pendingSend;
  el.picker.hidden = true;
  state.pendingSend = null;
  renderModelButton();
  if (state.chat) {
    api('PATCH', `/api/chats/${state.chat.id}`, { model: id }).catch(() => {});
  }
  if (pending) send();
  else if (!touch) el.input.focus();
}

async function toggleFavorite(id) {
  const on = state.favorites.includes(id);
  state.favorites = on ? state.favorites.filter((f) => f !== id) : [...state.favorites, id];
  renderModelList();
  try { await api('PUT', '/api/settings', { favorites: state.favorites }); } catch {}
}

const isLocal = (id) => typeof id === 'string' && id.startsWith('local/');

function modelInfo(id) {
  return state.models.find((m) => m.id === id) || state.local.models.find((m) => m.id === id) || null;
}

function shortModelName(id) {
  if (!id) return '';
  if (isLocal(id)) return id.slice('local/'.length);
  const m = modelInfo(id);
  if (m) return m.name.replace(/^[^:]+:\s*/, '');
  return id.split('/').pop();
}

function money(n) {
  if (n === null || n === undefined) return '?';
  if (n === 0) return 'gratis';
  return '$' + n.toLocaleString('nl-NL', { maximumFractionDigits: n < 1 ? 3 : 2 });
}

function contextLabel(n) {
  if (!n) return '';
  return n >= 1e6 ? `${(n / 1e6).toLocaleString('nl-NL', { maximumFractionDigits: 1 })}M` : `${Math.round(n / 1000)}k`;
}

function modelRow(m) {
  const row = document.createElement('div');
  const current = state.pickerMode === 'memory' ? state.memory?.writer?.model : state.model;
  row.className = 'model-row' + (m.id === current ? ' selected' : '');

  const pick = document.createElement('button');
  pick.type = 'button';
  pick.className = 'pick';
  const name = document.createElement('span');
  name.className = 'name';
  name.textContent = m.name;
  const addTag = (text, cls = '') => {
    const tag = document.createElement('span');
    tag.className = 'tag' + (cls ? ' ' + cls : '');
    tag.textContent = text;
    name.append(tag);
  };
  if (isLocal(m.id)) addTag('lokaal', 'local');
  if (m.tools) addTag('tools');
  const sub = document.createElement('span');
  sub.className = 'sub';
  if (isLocal(m.id)) {
    sub.textContent = `draait op je ${state.local.name} · gratis`;
  } else {
    const price = m.priceIn === 0 && m.priceOut === 0
      ? 'gratis'
      : `${money(m.priceIn)} in / ${money(m.priceOut)} uit per 1M`;
    sub.textContent = [m.id, price, contextLabel(m.context) && `${contextLabel(m.context)} context`].filter(Boolean).join(' · ');
  }
  pick.append(name, sub);
  pick.addEventListener('click', () => chooseModel(m.id));

  const star = document.createElement('button');
  star.type = 'button';
  const fav = state.favorites.includes(m.id);
  star.className = 'star' + (fav ? ' on' : '');
  star.setAttribute('aria-label', fav ? 'Uit favorieten' : 'Naar favorieten');
  star.innerHTML = '<svg viewBox="0 0 24 24"><path d="M12 3.5l2.6 5.3 5.9.9-4.3 4.1 1 5.8-5.2-2.7-5.2 2.7 1-5.8-4.3-4.1 5.9-.9z"/></svg>';
  star.addEventListener('click', () => toggleFavorite(m.id));

  row.append(pick, star);
  return row;
}

function renderModelList() {
  const list = el.modelList;
  list.replaceChildren();
  const words = el.modelSearch.value.toLowerCase().split(/\s+/).filter(Boolean);
  const haystack = (m) => `${m.id} ${m.name} ${isLocal(m.id) ? 'lokaal local ' + state.local.name : ''}`.toLowerCase();
  const match = (m) => words.every((w) => haystack(m).includes(w));

  const section = (text) => {
    const h = document.createElement('div');
    h.className = 'picker-section';
    h.textContent = text;
    list.append(h);
  };
  const note = (text) => {
    const n = document.createElement('div');
    n.className = 'picker-note';
    n.textContent = text;
    list.append(n);
  };

  let shown = 0;

  // Favorieten
  const favs = state.favorites
    .map((id) => modelInfo(id) || { id, name: isLocal(id) ? shortModelName(id) : id })
    .filter(match);
  if (favs.length) {
    section('Favorieten');
    list.append(...favs.map(modelRow));
    shown += favs.length;
  }

  // Lokaal op je eigen computer
  const localName = state.local.name || 'Mac';
  if (state.local.status === 'ok') {
    const locals = state.local.models.filter((m) => !state.favorites.includes(m.id) && match(m));
    if (locals.length) {
      section(`Lokaal op je ${localName}`);
      list.append(...locals.map(modelRow));
      shown += locals.length;
    }
  } else if (state.local.status === 'offline' && !words.length) {
    section(`Lokaal op je ${localName}`);
    note(`Je ${localName} is nu niet bereikbaar. Zet hem aan en open Ollama, dan verschijnen de lokale modellen hier.`);
  }

  // OpenRouter
  if (state.modelsError && !state.models.length) {
    section('OpenRouter');
    note(`Modellen konden niet worden opgehaald: ${state.modelsError}`);
    return;
  }
  if (!state.models.length) {
    note('Modellen ophalen…');
    return;
  }

  const rest = state.models.filter((m) => !state.favorites.includes(m.id) && match(m));
  if (!rest.length) {
    if (!shown) note('Niks gevonden.');
    return;
  }
  section(words.length ? `OpenRouter, gevonden (${rest.length})` : `OpenRouter (${rest.length})`);
  list.append(...rest.slice(0, 150).map(modelRow));
  if (rest.length > 150) note(`Nog ${rest.length - 150} modellen. Zoek om te filteren, bijvoorbeeld op "qwen".`);
}

// ---------- Weergave ----------

function render() {
  renderChatList();
  renderTitle();
  renderModelButton();
  renderMessages();
  renderComposer();
}

function renderTitle() {
  el.title.textContent = state.chat ? state.chat.title : 'Nieuwe chat';
  el.title.disabled = !state.chat;
  document.title = state.chat ? `${state.chat.title} · Maatje AI` : 'Maatje AI';
}

const EFFORT_LABELS = {
  default: 'standaard',
  none: 'uit',
  minimal: 'minimaal',
  low: 'laag',
  medium: 'middel',
  high: 'hoog',
  xhigh: 'extra hoog',
  max: 'max',
  on: 'aan',
};

function renderEffort() {
  const info = state.model ? modelInfo(state.model)?.effort : null;
  const sel = el.effortSel;
  if (!info) {
    sel.hidden = true;
    return;
  }
  const options = ['default', ...info.levels.filter((l) => l !== 'default')];
  if (!options.includes(state.effort)) state.effort = 'default';
  sel.replaceChildren(
    ...options.map((o) => {
      const opt = document.createElement('option');
      opt.value = o;
      const isDefault = o === 'default' && info.default;
      opt.textContent = `Denken: ${EFFORT_LABELS[o] || o}${isDefault ? ` (${EFFORT_LABELS[info.default] || info.default})` : ''}`;
      return opt;
    })
  );
  sel.value = state.effort;
  sel.hidden = false;
}

function renderModelButton() {
  renderEffort();
  el.modelLabel.textContent = state.model ? shortModelName(state.model) : 'Kies model';
  el.modelBtn.classList.toggle('missing', !state.model);
  el.modelBtn.title = state.model || '';
}

function renderComposer() {
  el.sendBtn.classList.toggle('stop', state.streaming);
  el.sendBtn.setAttribute('aria-label', state.streaming ? 'Stoppen' : 'Versturen');
}

function groupLabel(ts) {
  const d = new Date(ts);
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const diff = Math.floor((today - new Date(d).setHours(0, 0, 0, 0)) / 864e5);
  if (diff <= 0) return 'Vandaag';
  if (diff === 1) return 'Gisteren';
  if (diff < 7) return 'Afgelopen week';
  if (diff < 31) return 'Afgelopen maand';
  return 'Ouder';
}

function renderChatList() {
  const list = el.chatList;
  list.replaceChildren();
  if (!state.chats.length) {
    const e = document.createElement('div');
    e.className = 'chat-empty';
    e.textContent = 'Nog geen chats.';
    list.append(e);
    return;
  }
  let lastGroup = null;
  for (const c of state.chats) {
    const g = groupLabel(c.updated_at);
    if (g !== lastGroup) {
      const h = document.createElement('div');
      h.className = 'chat-group';
      h.textContent = g;
      list.append(h);
      lastGroup = g;
    }
    const item = document.createElement('div');
    item.className = 'chat-item' + (state.chat && state.chat.id === c.id ? ' active' : '');
    const a = document.createElement('a');
    a.href = `#/c/${c.id}`;
    a.textContent = c.title;
    item.append(a);
    if (c.generating) {
      const dot = document.createElement('span');
      dot.className = 'dot';
      dot.title = 'Antwoord loopt nog';
      item.prepend(dot);
    }
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'del';
    del.setAttribute('aria-label', 'Verwijderen');
    del.innerHTML = '<svg viewBox="0 0 24 24"><path d="M5 7h14M10 7V5h4v2M7 7l1 12h8l1-12"/></svg>';
    del.addEventListener('click', (e) => { e.preventDefault(); deleteChat(c.id); });
    item.append(del);
    list.append(item);
  }
}

function renderMarkdown(target, text) {
  target.innerHTML = DOMPurify.sanitize(marked.parse(text || ''));
  for (const pre of target.querySelectorAll('pre')) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'copy-code';
    btn.textContent = 'Kopieer';
    btn.addEventListener('click', () => copy(pre.querySelector('code')?.innerText || pre.innerText, btn));
    pre.append(btn);
  }
}

async function copy(text, btn) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // Zonder HTTPS werkt het klembord niet; dan via een tijdelijk tekstvak.
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.append(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  }
  if (btn) {
    const old = btn.textContent;
    btn.textContent = 'Gekopieerd';
    setTimeout(() => (btn.textContent = old), 1200);
  }
}

function usageLabel(u) {
  if (!u) return '';
  const parts = [];
  if (u.completion_tokens) parts.push(`${u.completion_tokens.toLocaleString('nl-NL')} tokens`);
  if (typeof u.cost === 'number') parts.push('$' + u.cost.toLocaleString('nl-NL', { maximumFractionDigits: 4 }));
  return parts.join(' · ');
}

function messageNode(m, isLast) {
  const wrap = document.createElement('div');
  wrap.className = `msg ${m.role}`;
  wrap.dataset.id = m.id;

  if (m.role === 'user') {
    const b = document.createElement('div');
    b.className = 'bubble';
    // "/skill-naam" aan het begin als label tonen.
    const sm = m.content.match(/^\/([a-z0-9][a-z0-9:_-]*)\s*/i);
    if (sm) {
      const tag = document.createElement('span');
      tag.className = 'slash-tag';
      tag.textContent = '/' + sm[1];
      b.append(tag, m.content.slice(sm[0].length));
    } else {
      b.textContent = m.content;
    }
    wrap.append(b);
    return wrap;
  }

  const body = document.createElement('div');
  body.className = 'body';
  wrap.append(body);
  fillReply(wrap, m);

  if (m.status !== 'streaming') {
    if (m.status === 'error') {
      const n = document.createElement('div');
      n.className = 'notice';
      n.textContent = m.error || 'Er ging iets mis.';
      wrap.append(n);
    } else if (m.status === 'stopped') {
      const n = document.createElement('div');
      n.className = 'notice soft';
      n.textContent = 'Gestopt.';
      wrap.append(n);
    } else if (m.status === 'interrupted') {
      const n = document.createElement('div');
      n.className = 'notice soft';
      n.textContent = 'Onderbroken doordat de server herstartte.';
      wrap.append(n);
    }

    if (m.meta?.tools?.length) wrap.append(toolLogNode(m.meta.tools));

    const meta = document.createElement('div');
    meta.className = 'meta';
    const who = document.createElement('span');
    who.textContent = shortModelName(m.model) + (m.meta?.effort ? ` · denken ${EFFORT_LABELS[m.meta.effort] || m.meta.effort}` : '');
    who.title = m.model || '';
    meta.append(who);
    const u = usageLabel(m.usage);
    if (u) {
      const s = document.createElement('span');
      s.textContent = u;
      meta.append(s);
    }
    const memFiles = (m.meta?.memoryFiles || []).filter((p) => p !== '/profile.md' && p !== '/preferences.md');
    if (memFiles.length) {
      const s = document.createElement('button');
      s.type = 'button';
      s.className = 'mem-used';
      const names = memFiles.map(fileLabel);
      s.textContent = `memory: ${names.slice(0, 3).join(', ')}${names.length > 3 ? ` +${names.length - 3}` : ''}`;
      s.title = memFiles.join('\n');
      s.addEventListener('click', () => openMemory(memFiles[0]));
      meta.append(s);
    }
    for (const name of m.meta?.skills || []) {
      const s = document.createElement('button');
      s.type = 'button';
      s.className = 'mem-used';
      s.textContent = `skill: ${name}`;
      s.addEventListener('click', () => openSkills(name));
      meta.append(s);
    }
    if (m.content) {
      const c = document.createElement('button');
      c.type = 'button';
      c.textContent = 'Kopieer';
      c.addEventListener('click', () => copy(m.content, c));
      meta.append(c);
    }
    if (isLast) {
      const r = document.createElement('button');
      r.type = 'button';
      r.textContent = 'Opnieuw';
      r.title = 'Opnieuw met het gekozen model';
      r.addEventListener('click', regenerate);
      meta.append(r);
    }
    wrap.append(meta);
  }
  return wrap;
}

function fillReply(wrap, m) {
  const body = wrap.querySelector('.body');
  fillApproval(wrap, m);
  if (m.status === 'streaming' && !m.content) {
    body.innerHTML = '';
    const t = document.createElement('div');
    t.className = 'thinking';
    t.textContent = m.statusText || (m.thinking ? 'Denkt na…' : 'Bezig…');
    body.append(t);
    return;
  }
  renderMarkdown(body, m.content);
  if (m.status === 'streaming') {
    if (m.statusText) {
      // Bijv. "Zoekt op internet…" na een eerste zin van het model.
      const t = document.createElement('div');
      t.className = 'thinking after';
      t.textContent = m.statusText;
      body.append(t);
    } else {
      const last = body.lastElementChild;
      (last && !last.matches('pre, table, ul, ol') ? last : body).classList.add('cursor');
    }
  }
}

// ---------- Toestemming en gebruikte tools ----------

const TOOL_LABELS = {
  web_search_exa: 'zoeken',
  web_fetch_exa: 'pagina lezen',
  execute_sql: 'query',
  list_tables: 'tabellen',
};

// Toont de argumenten leesbaar: één tekstveld (bijv. een SQL-query) los, anders als JSON.
function argsText(args) {
  if (typeof args === 'string') return args;
  if (args && typeof args === 'object') {
    const keys = Object.keys(args);
    const textKey = keys.find((k) => /^(query|sql|statement|code)$/i.test(k) && typeof args[k] === 'string');
    if (textKey && keys.length === 1) return args[textKey];
    if (!keys.length) return '(geen gegevens)';
  }
  return JSON.stringify(args, null, 2);
}

function fillApproval(wrap, m) {
  let slot = wrap.querySelector('.approval');
  const a = m.status === 'streaming' ? m.approval : null;
  if (!a) {
    if (slot) slot.remove();
    return;
  }
  if (slot && slot.dataset.id === a.id) return; // staat er al, niet opnieuw opbouwen
  if (slot) slot.remove();

  slot = document.createElement('div');
  slot.className = 'approval';
  slot.dataset.id = a.id;
  const head = document.createElement('div');
  head.className = 'approval-head';
  const strong = document.createElement('strong');
  strong.textContent = a.server;
  head.append('Mag ', strong, ' dit doen?');
  const tool = document.createElement('div');
  tool.className = 'approval-tool';
  tool.textContent = a.title ? `${a.title} (${a.tool})` : a.tool;
  const pre = document.createElement('pre');
  pre.textContent = argsText(a.args);

  const actions = document.createElement('div');
  actions.className = 'approval-actions';
  const msg = document.createElement('span');
  msg.className = 'mem-muted';
  const btn = (text, cls, decision) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = cls;
    b.textContent = text;
    b.addEventListener('click', async () => {
      for (const x of actions.querySelectorAll('button')) x.disabled = true;
      msg.textContent = decision === 'deny' ? 'Geweigerd.' : 'Bezig…';
      try {
        await api('POST', `/api/chats/${state.chat.id}/approval`, { id: a.id, decision });
        if (decision === 'always') refreshMcp();
      } catch (err) {
        msg.textContent = err.message;
        for (const x of actions.querySelectorAll('button')) x.disabled = false;
      }
    });
    return b;
  };
  actions.append(
    btn('Toestaan', 'btn-primary', 'allow'),
    btn('Altijd toestaan', 'btn-small', 'always'),
    btn('Weigeren', 'btn-deny', 'deny'),
    msg,
  );
  const note = document.createElement('div');
  note.className = 'approval-note';
  note.textContent = `"Altijd toestaan" geldt voor ${a.tool} van ${a.server}. Terugdraaien kan bij MCP.`;
  slot.append(head, tool, pre, actions, note);
  wrap.querySelector('.body').after(slot);
}

function toolLogNode(tools) {
  const d = document.createElement('details');
  d.className = 'tool-log';
  const sum = document.createElement('summary');
  const servers = [...new Set(tools.map((t) => t.server))];
  sum.textContent = `${tools.length} ${tools.length === 1 ? 'actie' : 'acties'} via ${servers.join(', ')}`;
  d.append(sum);
  for (const t of tools) {
    const row = document.createElement('div');
    row.className = 'tool-entry';
    const top = document.createElement('div');
    top.className = 'tool-top';
    const name = document.createElement('span');
    name.textContent = `${t.server} · ${TOOL_LABELS[t.tool] || t.tool}`;
    name.title = t.tool;
    const st = document.createElement('span');
    const [label, cls] = t.denied
      ? [t.approval === 'timeout' ? 'geen antwoord' : 'geweigerd', 'warn']
      : t.ok === true ? ['gelukt', 'ok']
      : t.ok === false ? ['fout', 'err']
      : ['gestopt', 'warn'];
    st.className = `tool-state ${cls}`;
    st.textContent = label + (t.approval === 'allow' || t.approval === 'always' ? ' · door jou toegestaan' : '');
    top.append(name, st);
    row.append(top);
    const args = document.createElement('pre');
    args.textContent = argsText(t.args);
    row.append(args);
    if (t.result || t.error) {
      const res = document.createElement('pre');
      res.className = 'tool-result';
      res.textContent = t.error || t.result;
      row.append(res);
    }
    d.append(row);
  }
  return d;
}

function renderMessages() {
  const box = el.messages;
  box.replaceChildren();

  if (!state.messages.length) {
    const e = document.createElement('div');
    e.className = 'empty';
    const s = document.createElement('strong');
    const em = document.createElement('em');
    em.textContent = 'chat';
    s.append('Nieuwe ', em);
    const p = document.createElement('div');
    p.textContent = state.model ? `Met ${shortModelName(state.model)}` : 'Kies rechtsboven eerst een model';
    e.append(s, p);
    box.append(e);
    return;
  }

  // Na een gebruikersbericht zonder antwoord (fout bij versturen) toch "Opnieuw" tonen.
  const lastIdx = state.messages.length - 1;
  state.messages.forEach((m, i) => box.append(messageNode(m, i === lastIdx)));

  const last = state.messages[lastIdx];
  if (last.role === 'user' && !state.streaming) {
    const meta = document.createElement('div');
    meta.className = 'meta';
    const r = document.createElement('button');
    r.type = 'button';
    r.textContent = 'Antwoord ophalen';
    r.addEventListener('click', regenerate);
    meta.append(r);
    box.append(meta);
  }
}

let renderQueued = false;
function scheduleReplyRender(reply) {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => {
    renderQueued = false;
    const node = el.messages.querySelector(`.msg[data-id="${CSS.escape(String(reply.id))}"]`)
      || el.messages.querySelector('.msg[data-id="tmp-reply"]');
    const near = isNearBottom();
    if (node) {
      node.dataset.id = reply.id;
      fillReply(node, reply);
    } else {
      renderMessages();
    }
    if (near) scrollToBottom(true);
  });
}

function isNearBottom() {
  const b = el.messages;
  return b.scrollHeight - b.scrollTop - b.clientHeight < 120;
}

function scrollToBottom(force = false) {
  if (force || isNearBottom()) el.messages.scrollTop = el.messages.scrollHeight;
}

function autosize() {
  el.input.style.height = 'auto';
  el.input.style.height = Math.min(el.input.scrollHeight, window.innerHeight * 0.4) + 'px';
}

function closeNav() { el.app.classList.remove('nav-open'); }


// ---------- Memory ----------

const GROUPS = [
  { key: 'top', title: 'Algemeen', test: (p) => p === '/profile.md' || p === '/preferences.md' },
  { key: 'people', title: 'Mensen en bedrijven', test: (p) => p.startsWith('/people/') },
  { key: 'areas', title: 'Projecten en lopende zaken', test: (p) => p.startsWith('/areas/') },
  { key: 'topics', title: 'Onderwerpen', test: (p) => p.startsWith('/topics/') },
];

function fileLabel(p) {
  if (p === '/profile.md') return 'profiel';
  if (p === '/preferences.md') return 'voorkeuren';
  return p.split('/').pop().replace(/\.md$/, '');
}

function prettyName(f) {
  if (f.path === '/profile.md') return 'Profiel';
  if (f.path === '/preferences.md') return 'Voorkeuren';
  const n = (f.name || fileLabel(f.path)).replace(/-/g, ' ');
  return n.charAt(0).toUpperCase() + n.slice(1);
}

function timeLabel(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const sameDay = new Date().toDateString() === d.toDateString();
  return sameDay
    ? d.toLocaleTimeString('nl-NL', { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleString('nl-NL', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

async function refreshMemoryBadge() {
  try {
    const r = await api('GET', '/api/memory');
    state.memory = r;
    const w = r.writer;
    const n = w.pending;
    el.memoryBadge.hidden = !(n > 0 || w.lastError);
    el.memoryBadge.textContent = w.lastError && !n ? '!' : String(n);
    el.memoryBadge.classList.toggle('warn', Boolean(w.lastError));
    if (!el.memorySheet.hidden && memView.mode === 'list') renderMemoryList();
  } catch {}
}

const memView = { mode: 'list', path: null, search: '', dirty: false };

async function loadMemory() {
  try {
    state.memory = await api('GET', '/api/memory');
  } catch (err) {
    el.memBody.textContent = `Memory kon niet worden geladen: ${err.message}`;
    return;
  }
  refreshMemoryBadge();
  if (memView.mode === 'list') renderMemoryList();
}

async function openMemory(path = null) {
  closeNav();
  el.memorySheet.hidden = false;
  el.memBody.textContent = 'Laden…';
  await loadMemory();
  if (path) openMemoryFile(path);
}

function closeMemory() {
  if (memView.dirty && !confirm('Je wijzigingen zijn nog niet opgeslagen. Toch sluiten?')) return;
  memView.dirty = false;
  el.memorySheet.hidden = true;
  memView.mode = 'list';
}

function writerStatusText(w) {
  if (!w.enabled) return 'Bijwerken staat uit.';
  const parts = [];
  if (w.running) parts.push('Bezig met bijwerken…');
  else if (w.waiting === 'model') parts.push('Er is nog geen model gekozen om de memory bij te werken. Kies er een met Wijzig.');
  else if (w.waiting === 'mac') parts.push(`Wacht tot je ${state.local?.name || 'computer'} bereikbaar is${w.pending ? ` (${w.pending} gesprek${w.pending === 1 ? '' : 'ken'} in de wachtrij)` : ''}.`);
  else if (w.pending) parts.push(`${w.pending} gesprek${w.pending === 1 ? '' : 'ken'} in de wachtrij.`);
  if (w.lastRun) {
    const changed = (w.lastChanged || []).map(fileLabel).join(', ');
    parts.push(`Laatst gecheckt ${timeLabel(w.lastRun)}${changed ? `, bijgewerkt: ${changed}` : ', niks nieuws'}.`);
  }
  if (w.lastError) parts.push(`Laatste fout: ${w.lastError}`);
  return parts.join(' ') || 'Werkt bij na elk afgerond antwoord.';
}

function renderMemoryList() {
  memView.mode = 'list';
  memView.path = null;
  el.memTitle.textContent = 'Memory';
  el.memBack.hidden = true;
  const box = el.memBody;
  box.replaceChildren();
  const m = state.memory;
  if (!m) return;
  const w = m.writer;

  // Bijwerker
  const card = document.createElement('div');
  card.className = 'mem-card';
  const row1 = document.createElement('div');
  row1.className = 'mem-row';
  const label = document.createElement('label');
  label.className = 'switch';
  const cb = document.createElement('input');
  cb.type = 'checkbox';
  cb.checked = w.enabled;
  cb.addEventListener('change', async () => {
    try { await api('PUT', '/api/settings', { memoryEnabled: cb.checked }); } catch {}
    loadMemory();
  });
  label.append(cb, document.createTextNode(' Bijwerken na elk gesprek'));
  row1.append(label);
  const row2 = document.createElement('div');
  row2.className = 'mem-row';
  const who = document.createElement('span');
  who.className = 'mem-muted';
  who.textContent = w.model ? `Door: ${shortModelName(w.model)}` : 'Door: nog geen model gekozen';
  const change = document.createElement('button');
  change.type = 'button';
  change.className = 'link-btn';
  change.textContent = 'Wijzig';
  change.addEventListener('click', () => openPicker('memory'));
  row2.append(who, change);
  const status = document.createElement('div');
  status.className = 'mem-status' + (w.lastError ? ' err' : '');
  status.textContent = writerStatusText(w);
  card.append(row1, row2, status);
  box.append(card);

  // Zoeken en nieuw
  const bar = document.createElement('div');
  bar.className = 'mem-bar';
  const search = document.createElement('input');
  search.type = 'search';
  search.placeholder = `Zoek in ${m.files.length} bestanden`;
  search.value = memView.search;
  search.addEventListener('input', () => {
    memView.search = search.value;
    renderGroups();
  });
  const add = document.createElement('button');
  add.type = 'button';
  add.className = 'btn-small';
  add.textContent = '+ Nieuw';
  add.addEventListener('click', newMemoryFile);
  bar.append(search, add);
  box.append(bar);

  const groupsBox = document.createElement('div');
  box.append(groupsBox);

  function renderGroups() {
    groupsBox.replaceChildren();
    const words = memView.search.toLowerCase().split(/\s+/).filter(Boolean);
    const match = (f) => {
      const hay = `${f.path} ${f.name} ${f.description} ${f.aliases.join(' ')}`.toLowerCase();
      return words.every((x) => hay.includes(x));
    };
    let any = false;
    for (const g of GROUPS) {
      const items = m.files.filter((f) => g.test(f.path) && match(f));
      if (!items.length) continue;
      any = true;
      const h = document.createElement('div');
      h.className = 'picker-section';
      h.textContent = `${g.title} (${items.length})`;
      groupsBox.append(h);
      for (const f of items) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'mem-item';
        const n = document.createElement('span');
        n.className = 'name';
        n.textContent = prettyName(f);
        const d = document.createElement('span');
        d.className = 'sub';
        d.textContent = f.description || f.path;
        b.append(n, d);
        b.addEventListener('click', () => openMemoryFile(f.path));
        groupsBox.append(b);
      }
    }
    if (!any) {
      const n = document.createElement('div');
      n.className = 'picker-note';
      n.textContent = m.files.length ? 'Niks gevonden.' : 'Nog geen bestanden. Na je volgende gesprekken vult de memory zich vanzelf.';
      groupsBox.append(n);
    }
  }
  renderGroups();

  // Laatste wijzigingen
  const hist = document.createElement('details');
  hist.className = 'mem-history';
  const sum = document.createElement('summary');
  sum.textContent = 'Laatste wijzigingen';
  hist.append(sum);
  hist.addEventListener('toggle', async () => {
    if (!hist.open || hist.dataset.loaded) return;
    hist.dataset.loaded = '1';
    try {
      const r = await api('GET', '/api/memory/history');
      if (!r.history.length) {
        const n = document.createElement('div');
        n.className = 'picker-note';
        n.textContent = 'Nog geen wijzigingen.';
        hist.append(n);
      }
      for (const e of r.history) {
        const row = document.createElement('div');
        row.className = 'mem-hist-row';
        const t = document.createElement('span');
        t.className = 'mem-muted';
        t.textContent = timeLabel(e.date);
        const files = document.createElement('span');
        const shown = e.files.slice(0, 4);
        if (e.message.includes('begintoestand')) files.textContent = `Begintoestand (${e.files.length} bestanden)`;
        else {
          for (const f of shown) {
            const a = document.createElement('button');
            a.type = 'button';
            a.className = 'link-btn';
            a.textContent = (f.status === 'D' ? '− ' : f.status === 'A' ? '+ ' : '') + fileLabel(f.path);
            if (f.status !== 'D') a.addEventListener('click', () => openMemoryFile(f.path));
            files.append(a, document.createTextNode(' '));
          }
          if (e.files.length > shown.length) files.append(document.createTextNode(`+${e.files.length - shown.length}`));
          if (e.message.startsWith('memory (jij)')) {
            const tag = document.createElement('span');
            tag.className = 'mem-muted';
            tag.textContent = ' (door jou)';
            files.append(tag);
          }
        }
        row.append(t, files);
        hist.append(row);
      }
    } catch (err) {
      hist.append(document.createTextNode(err.message));
    }
  });
  box.append(hist);
}

async function openMemoryFile(path, presetContent = null) {
  let content = presetContent;
  if (content === null) {
    try {
      content = (await api('GET', `/api/memory/file?path=${encodeURIComponent(path)}`)).content;
    } catch (err) {
      alert(err.message);
      return;
    }
  }
  memView.mode = 'file';
  memView.path = path;
  memView.dirty = presetContent !== null;
  el.memTitle.textContent = path;
  el.memBack.hidden = false;
  const box = el.memBody;
  box.replaceChildren();

  const ta = document.createElement('textarea');
  ta.className = 'mem-editor';
  ta.value = content;
  ta.spellcheck = false;
  ta.addEventListener('input', () => { memView.dirty = true; });

  const actions = document.createElement('div');
  actions.className = 'mem-actions';
  const save = document.createElement('button');
  save.type = 'button';
  save.className = 'btn-primary';
  save.textContent = 'Opslaan';
  const msg = document.createElement('span');
  msg.className = 'mem-muted';
  save.addEventListener('click', async () => {
    try {
      await api('PUT', '/api/memory/file', { path, content: ta.value });
      memView.dirty = false;
      msg.textContent = 'Opgeslagen.';
      state.memory = await api('GET', '/api/memory');
    } catch (err) {
      msg.textContent = err.message;
    }
  });
  const del = document.createElement('button');
  del.type = 'button';
  del.className = 'btn-danger';
  del.textContent = 'Verwijderen';
  del.addEventListener('click', async () => {
    if (!confirm(`${path} verwijderen? In de geschiedenis blijft hij terug te vinden.`)) return;
    try {
      await api('DELETE', `/api/memory/file?path=${encodeURIComponent(path)}`);
      memView.dirty = false;
      await loadMemory();
    } catch (err) {
      msg.textContent = err.message;
    }
  });
  actions.append(save, msg, del);
  box.append(ta, actions);
  if (!touch) ta.focus();
}

function newMemoryFile() {
  const kind = prompt('Wat voor bestand?\n1 = persoon of bedrijf\n2 = project of lopende zaak\n3 = onderwerp', '1');
  const folder = { 1: 'people', 2: 'areas', 3: 'topics' }[String(kind || '').trim()];
  if (!folder) return;
  const name = prompt('Naam (bijv. "Café Gogi")');
  if (!name || !name.trim()) return;
  const slug = name.trim().toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
  if (!slug) return;
  const path = `/${folder}/${slug}.md`;
  if (state.memory?.files.some((f) => f.path === path)) {
    openMemoryFile(path);
    return;
  }
  const template = `---\nname: ${slug}\ndescription: ${name.trim()}\naliases: [${name.trim()}]\n---\n- \n`;
  openMemoryFile(path, template);
}

el.memoryBtn.addEventListener('click', () => openMemory());
el.memClose.addEventListener('click', closeMemory);
el.memBack.addEventListener('click', () => {
  if (memView.dirty && !confirm('Je wijzigingen zijn nog niet opgeslagen. Toch terug?')) return;
  memView.dirty = false;
  renderMemoryList();
});
setInterval(() => {
  if (!el.memorySheet.hidden && memView.mode === 'list') refreshMemoryBadge();
}, 5000);

// ---------- Skills ----------

const skillView = { mode: 'list', name: null, search: '', dirty: false };

async function loadSkills() {
  try {
    state.skills = (await api('GET', '/api/skills')).skills;
  } catch {}
  if (!el.skillSheet.hidden && skillView.mode === 'list') renderSkillList();
}

async function openSkills(name = null) {
  closeNav();
  el.skillSheet.hidden = false;
  el.skillBody.textContent = 'Laden…';
  await loadSkills();
  if (name) openSkill(name);
  else renderSkillList();
}

function closeSkills() {
  if (skillView.dirty && !confirm('Je wijzigingen zijn nog niet opgeslagen. Toch sluiten?')) return;
  skillView.dirty = false;
  el.skillSheet.hidden = true;
  skillView.mode = 'list';
}

function renderSkillList(message = null) {
  skillView.mode = 'list';
  skillView.name = null;
  el.skillTitle.textContent = 'Skills';
  el.skillBack.hidden = true;
  const box = el.skillBody;
  box.replaceChildren();

  box.append(node('p', 'mcp-intro', 'Skills zijn vaste werkwijzen die een model erbij pakt als ze bij je vraag passen. Wil je er zelf een kiezen, begin je bericht dan met / en de naam van de skill.'));

  const bar = node('div', 'mem-bar');
  const search = document.createElement('input');
  search.type = 'search';
  search.placeholder = `Zoek in ${state.skills.length} skills`;
  search.value = skillView.search;
  const up = node('button', 'btn-small', 'Uploaden');
  up.type = 'button';
  up.title = 'Een .zip, .skill of SKILL.md';
  up.addEventListener('click', () => el.skillFile.click());
  const add = node('button', 'btn-small', '+ Nieuw');
  add.type = 'button';
  add.addEventListener('click', newSkill);
  bar.append(search, up, add);
  box.append(bar);

  if (message) {
    const m = node('div', `mem-status${message.err ? ' err' : ''}`, message.text);
    m.classList.add('skill-msg');
    box.append(m);
  }

  const list = node('div');
  box.append(list);
  const renderItems = () => {
    list.replaceChildren();
    const words = skillView.search.toLowerCase().split(/\s+/).filter(Boolean);
    const items = state.skills.filter((s) => words.every((w) => `${s.name} ${s.description}`.toLowerCase().includes(w)));
    if (!items.length) {
      list.append(node('div', 'picker-note', state.skills.length ? 'Niks gevonden.' : 'Nog geen skills. Upload een skill (.zip, .skill of SKILL.md) of maak er een met + Nieuw.'));
      return;
    }
    for (const s of items) {
      const row = node('div', 'skill-row' + (s.enabled ? '' : ' off'));
      const b = node('button', 'mem-item');
      b.type = 'button';
      b.append(node('span', 'name', s.name), node('span', 'sub', s.description || '(geen omschrijving)'));
      b.addEventListener('click', () => openSkill(s.name));
      const sw = node('label', 'switch');
      sw.title = s.enabled ? 'Staat aan' : 'Staat uit';
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = s.enabled;
      cb.setAttribute('aria-label', `${s.name} aan of uit`);
      cb.addEventListener('change', async () => {
        try { await api('PATCH', `/api/skills/${s.name}`, { enabled: cb.checked }); } catch (err) { alert(err.message); }
        loadSkills();
      });
      sw.append(cb);
      row.append(b, sw);
      list.append(row);
    }
  };
  search.addEventListener('input', () => {
    skillView.search = search.value;
    renderItems();
  });
  renderItems();
}

async function openSkill(name, preset = null) {
  let s = preset;
  if (!s) {
    try {
      s = (await api('GET', `/api/skills/${encodeURIComponent(name)}`)).skill;
    } catch (err) {
      alert(err.message);
      return;
    }
  }
  skillView.mode = 'file';
  skillView.name = name;
  skillView.dirty = Boolean(preset);
  el.skillTitle.textContent = name;
  el.skillBack.hidden = false;
  const box = el.skillBody;
  box.replaceChildren();

  const ta = document.createElement('textarea');
  ta.className = 'mem-editor';
  ta.value = s.content;
  ta.spellcheck = false;
  ta.addEventListener('input', () => { skillView.dirty = true; });
  box.append(ta);

  if (s.files?.length) {
    const d = node('details', 'mem-history');
    d.append(node('summary', '', `Extra bestanden (${s.files.length})`));
    const ul = node('div', 'skill-files');
    ul.textContent = s.files.join('\n');
    d.append(ul);
    box.append(d);
  }

  const actions = node('div', 'mem-actions');
  const save = node('button', 'btn-primary', 'Opslaan');
  save.type = 'button';
  const msg = node('span', 'mem-muted');
  save.addEventListener('click', async () => {
    try {
      await api('PUT', `/api/skills/${encodeURIComponent(name)}`, { content: ta.value });
      skillView.dirty = false;
      msg.textContent = 'Opgeslagen.';
      loadSkills();
    } catch (err) {
      msg.textContent = err.message;
    }
  });
  const use = node('button', 'btn-small', `Gebruik in chat`);
  use.type = 'button';
  use.title = `Zet /${name} in het berichtvak`;
  use.addEventListener('click', () => {
    if (skillView.dirty && !confirm('Je wijzigingen zijn nog niet opgeslagen. Toch doorgaan?')) return;
    skillView.dirty = false;
    el.skillSheet.hidden = true;
    el.input.value = `/${name} ` + el.input.value.replace(/^\/[^\s]*\s*/, '');
    autosize();
    el.input.focus();
  });
  const del = node('button', 'btn-danger', 'Verwijderen');
  del.type = 'button';
  del.addEventListener('click', async () => {
    if (!confirm(`Skill ${name} verwijderen?`)) return;
    try {
      await api('DELETE', `/api/skills/${encodeURIComponent(name)}`);
      skillView.dirty = false;
      await loadSkills();
      renderSkillList();
    } catch (err) {
      msg.textContent = err.message;
    }
  });
  actions.append(save, use, msg, del);
  box.append(actions);
}

function newSkill() {
  const raw = prompt('Naam van de skill (bijv. "offerte-opvolgen")');
  if (!raw || !raw.trim()) return;
  const name = raw.trim().toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64);
  if (!name) return;
  if (state.skills.some((s) => s.name === name)) {
    openSkill(name);
    return;
  }
  const content = `---\nname: ${name}\ndescription: Wanneer deze skill gebruikt moet worden, in één of twee zinnen.\n---\n\n# ${raw.trim()}\n\nSchrijf hier de werkwijze.\n`;
  openSkill(name, { name, content, files: [] });
}

async function uploadSkills(files) {
  const lines = [];
  let err = false;
  for (const f of files) {
    try {
      const res = await fetch('/api/skills/upload', {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream', 'X-Filename': encodeURIComponent(f.name) },
        body: f,
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j.error || `Fout ${res.status}`);
      for (const r of j.results) lines.push(`${r.name}: ${r.status}${r.reason ? ` (${r.reason})` : ''}`);
    } catch (e) {
      err = true;
      lines.push(`${f.name}: ${e.message}`);
    }
  }
  await loadSkills();
  renderSkillList({ text: lines.join(' · '), err });
}

el.skillsBtn.addEventListener('click', () => openSkills());
el.skillClose.addEventListener('click', closeSkills);
el.skillBack.addEventListener('click', () => {
  if (skillView.dirty && !confirm('Je wijzigingen zijn nog niet opgeslagen. Toch terug?')) return;
  skillView.dirty = false;
  renderSkillList();
});
el.skillFile.addEventListener('change', () => {
  const files = [...el.skillFile.files];
  el.skillFile.value = '';
  if (files.length) uploadSkills(files);
});

// ---------- /-suggesties in het berichtvak ----------

const slash = { items: [], index: 0 };

function updateSlashMenu() {
  const m = el.input.value.match(/^\/([a-z0-9:_-]*)$/i);
  const enabled = state.skills.filter((s) => s.enabled);
  if (!m || !enabled.length) return hideSlashMenu();
  const q = m[1].toLowerCase();
  // Eerst skills waarvan de naam past, daarna die waar het in de omschrijving staat.
  const score = (s) => {
    if (!q) return 1;
    if (s.name.startsWith(q)) return 4;
    if (s.name.split('-').some((part) => part.startsWith(q))) return 3;
    if (s.name.includes(q)) return 2;
    return s.description.toLowerCase().includes(q) ? 1 : 0;
  };
  slash.items = enabled
    .map((s) => [s, score(s)])
    .filter(([, sc]) => sc > 0)
    .sort((a, b) => b[1] - a[1] || a[0].name.localeCompare(b[0].name))
    .map(([s]) => s)
    .slice(0, 8);
  if (!slash.items.length) return hideSlashMenu();
  slash.index = Math.min(slash.index, slash.items.length - 1);
  el.slashMenu.replaceChildren(
    ...slash.items.map((s, i) => {
      const b = node('button', 'slash-item' + (i === slash.index ? ' active' : ''));
      b.type = 'button';
      b.setAttribute('role', 'option');
      b.append(node('span', 'name', '/' + s.name), node('span', 'sub', s.description));
      // pointerdown, zodat het berichtvak de focus houdt (ook op de telefoon)
      b.addEventListener('pointerdown', (e) => { e.preventDefault(); pickSlash(i); });
      return b;
    })
  );
  el.slashMenu.hidden = false;
}

function hideSlashMenu() {
  el.slashMenu.hidden = true;
  slash.items = [];
  slash.index = 0;
}

function pickSlash(i) {
  const s = slash.items[i];
  if (!s) return;
  el.input.value = `/${s.name} `;
  hideSlashMenu();
  autosize();
  el.input.focus();
}

// ---------- MCP ----------

const mcpView = { mode: 'list', preset: null };

const STATUS_TEXT = {
  ok: 'Verbonden',
  connecting: 'Verbinden…',
  auth: 'Inloggen nodig',
  error: 'Werkt niet',
  off: 'Uit',
};

async function refreshMcp() {
  try {
    state.mcp = await api('GET', '/api/mcp');
  } catch {
    return;
  }
  const bad = state.mcp.servers.filter((s) => s.enabled && (s.status === 'auth' || s.status === 'error'));
  el.mcpBadge.hidden = !bad.length;
  el.mcpBadge.textContent = '!';
  el.mcpBadge.classList.toggle('warn', bad.length > 0);
  if (!el.mcpSheet.hidden && mcpView.mode === 'list') renderMcpList();
}

async function openMcp() {
  closeNav();
  el.mcpSheet.hidden = false;
  mcpView.mode = 'list';
  el.mcpBody.textContent = 'Laden…';
  await refreshMcp();
  renderMcpList();
}

function closeMcp() {
  el.mcpSheet.hidden = true;
  mcpView.mode = 'list';
}

function node(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}

// Inloggen gebeurt in een nieuw tabblad. Dat openen we meteen bij de klik,
// anders houdt de browser het tegen als pop-up.
function openAuthWindow() {
  let win = null;
  try { win = window.open('', '_blank'); } catch {}
  try {
    win?.document.write('<title>Inloggen…</title><p style="font:16px system-ui,sans-serif;padding:32px;color:#5b616e">Inlogpagina openen…</p>');
  } catch {}
  return win;
}

function followAuth(win, server, msgEl) {
  if (server?.status === 'auth' && server.authUrl) {
    if (win && !win.closed) {
      win.location.href = server.authUrl;
    } else if (msgEl) {
      msgEl.replaceChildren('Inloggen nodig: ');
      const a = node('a', 'link-btn', `Inloggen bij ${server.name}`);
      a.href = server.authUrl;
      a.target = '_blank';
      a.rel = 'noopener';
      msgEl.append(a);
    }
    return true;
  }
  if (win && !win.closed) win.close();
  return false;
}

async function mcpLogin(s, msgEl, { openWindow = true } = {}) {
  const win = openWindow ? openAuthWindow() : null;
  if (msgEl) msgEl.textContent = 'Bezig…';
  try {
    const r = await api('POST', `/api/mcp/servers/${s.id}/connect`, { origin: location.origin });
    const waiting = followAuth(win, r.server, msgEl);
    if (msgEl && waiting && win && !win.closed) msgEl.textContent = 'Log in het nieuwe tabblad in en kom daarna hier terug.';
  } catch (err) {
    if (win && !win.closed) win.close();
    if (msgEl) msgEl.textContent = err.message;
  }
  refreshMcp();
}

function renderMcpList() {
  mcpView.mode = 'list';
  el.mcpTitle.textContent = 'MCP';
  el.mcpBack.hidden = true;
  const box = el.mcpBody;
  box.replaceChildren();

  box.append(node('p', 'mcp-intro', 'Via MCP kan een model bij andere apps. Lezen gaat vanzelf; wil een model iets wijzigen, dan vraagt Maatje AI eerst of het mag. Werkt met modellen met het label "tools", ook lokale modellen die tools kunnen.'));

  const servers = state.mcp?.servers || [];
  for (const s of servers) box.append(mcpCard(s));
  if (!servers.length) box.append(node('div', 'picker-note', 'Nog geen MCP-servers.'));

  const add = node('button', 'btn-primary mcp-add', '+ MCP-server toevoegen');
  add.type = 'button';
  add.addEventListener('click', renderMcpChoose);
  box.append(add);
}

function mcpCard(s) {
  const card = node('div', 'mem-card mcp-card');
  const top = node('div', 'mcp-top');
  const name = node('div', 'mcp-name', s.name);
  const chip = node('span', `chip ${s.status}`, STATUS_TEXT[s.status] || s.status);
  if (s.status === 'ok') chip.textContent = `Verbonden · ${s.tools.length} tools`;
  const sw = node('label', 'switch');
  const cb = document.createElement('input');
  cb.type = 'checkbox';
  cb.checked = s.enabled;
  cb.addEventListener('change', async () => {
    try { await api('PATCH', `/api/mcp/servers/${s.id}`, { enabled: cb.checked, origin: location.origin }); } catch (err) { alert(err.message); }
    refreshMcp();
  });
  sw.append(cb, document.createTextNode(' Aan'));
  top.append(name, chip, sw);
  card.append(top);

  const sub = node('div', 'mem-muted mcp-url', s.url);
  card.append(sub);

  const msg = node('div', 'mem-status');
  if (s.enabled && s.status === 'error' && s.error) {
    msg.classList.add('err');
    msg.textContent = s.error;
  } else if (s.enabled && s.status === 'auth') {
    msg.textContent = `Log in bij ${s.name} om deze server te gebruiken.`;
  }

  const actions = node('div', 'mcp-actions');
  if (s.enabled && s.status === 'auth') {
    const b = node('button', 'btn-primary', `Inloggen bij ${s.name}`);
    b.type = 'button';
    b.addEventListener('click', () => mcpLogin(s, msg));
    actions.append(b);
  }
  if (s.enabled && (s.status === 'error' || s.status === 'ok')) {
    const b = node('button', 'btn-small', 'Opnieuw verbinden');
    b.type = 'button';
    b.addEventListener('click', async () => {
      b.disabled = true;
      msg.classList.remove('err');
      msg.textContent = 'Verbinden…';
      await mcpLogin(s, msg, { openWindow: false });
    });
    actions.append(b);
  }
  if (s.loggedIn) {
    const b = node('button', 'link-btn', 'Uitloggen');
    b.type = 'button';
    b.addEventListener('click', async () => {
      if (!confirm(`Uitloggen bij ${s.name}? Daarna moet je opnieuw inloggen om deze server te gebruiken.`)) return;
      try { await api('POST', `/api/mcp/servers/${s.id}/logout`); } catch {}
      refreshMcp();
    });
    actions.append(b);
  }
  const del = node('button', 'btn-danger', 'Verwijderen');
  del.type = 'button';
  del.addEventListener('click', async () => {
    if (!confirm(`MCP-server ${s.name} verwijderen?`)) return;
    try { await api('DELETE', `/api/mcp/servers/${s.id}`); } catch {}
    refreshMcp();
  });
  actions.append(del);
  card.append(msg, actions);

  if (s.tools.length) {
    const d = node('details', 'mcp-tools');
    const ask = s.tools.filter((t) => !t.auto).length;
    d.append(node('summary', '', `Tools (${s.tools.length})${ask ? ` · ${ask} vraagt eerst om toestemming` : ' · alles gaat vanzelf'}`));
    for (const t of s.tools) {
      const row = node('div', 'mcp-tool');
      const left = node('div', 'mcp-tool-text');
      left.append(node('span', 'name', t.title || t.name), node('span', 'sub', t.description || t.name));
      row.append(left);
      if (t.readOnly) {
        row.append(node('span', 'mcp-tool-ro', 'leest alleen'));
      } else {
        const l = node('label', 'switch mcp-tool-auto');
        const c = document.createElement('input');
        c.type = 'checkbox';
        c.checked = t.auto;
        c.addEventListener('change', async () => {
          try { await api('PATCH', `/api/mcp/servers/${s.id}`, { autoApprove: { [t.name]: c.checked } }); } catch (err) { alert(err.message); }
          refreshMcp();
        });
        l.append(c, document.createTextNode(' zonder vragen'));
        row.append(l);
      }
      d.append(row);
    }
    card.append(d);
  }
  return card;
}

const PRESETS = [
  { key: 'supabase', title: 'Supabase', text: 'Je database bekijken en vragen beantwoorden met de gegevens die erin staan.' },
  { key: 'exa', title: 'Op internet zoeken', text: 'Zoeken en webpagina\'s lezen via Exa, zodat ook lokale modellen actuele informatie kunnen opzoeken. Werkt zonder account.' },
  { key: 'custom', title: 'Andere MCP-server', text: 'Elke andere server met een https-adres.' },
];

function showMcpSub(title) {
  mcpView.mode = 'form';
  el.mcpTitle.textContent = title;
  el.mcpBack.hidden = false;
  el.mcpBody.replaceChildren();
  return el.mcpBody;
}

function renderMcpChoose() {
  const box = showMcpSub('MCP-server toevoegen');
  for (const p of PRESETS) {
    const b = node('button', 'mcp-choice');
    b.type = 'button';
    b.append(node('span', 'name', p.title), node('span', 'sub', p.text));
    b.addEventListener('click', () => renderMcpForm(p.key));
    box.append(b);
  }
}

function field(labelText, input, help) {
  const wrap = node('label', 'field');
  wrap.append(node('span', 'field-label', labelText), input);
  if (help) wrap.append(node('span', 'field-help', help));
  return wrap;
}

function textInput(placeholder, type = 'text') {
  const i = document.createElement('input');
  i.type = type;
  i.placeholder = placeholder;
  i.autocomplete = 'off';
  i.spellcheck = false;
  return i;
}

function renderMcpForm(preset) {
  const p = PRESETS.find((x) => x.key === preset);
  const box = showMcpSub(p.title);
  const form = node('form', 'mcp-form');
  const inputs = {};

  if (preset === 'supabase') {
    inputs.projectRef = textInput('bijv. abcdefghijklmnopqrst of de link van je project');
    form.append(field('Project', inputs.projectRef, 'Plak de link van je project uit het Supabase-dashboard, of alleen de project-ref. Leeg laten = toegang tot al je projecten.'));
    const ro = node('label', 'switch');
    inputs.readOnly = document.createElement('input');
    inputs.readOnly.type = 'checkbox';
    inputs.readOnly.checked = true;
    ro.append(inputs.readOnly, document.createTextNode(' Alleen lezen (aanbevolen)'));
    form.append(ro, node('span', 'field-help', 'Dan kan het model niks in je database aanpassen, ook niet per ongeluk. Vragen stellen over je gegevens kan gewoon.'));
    const adv = node('details', 'mcp-adv');
    adv.append(node('summary', '', 'Liever een access token dan inloggen?'));
    inputs.token = textInput('sbp_...', 'password');
    adv.append(field('Personal access token', inputs.token, 'Maak je aan in Supabase onder Account › Access Tokens. Laat leeg om gewoon in te loggen.'));
    form.append(adv);
  } else if (preset === 'exa') {
    inputs.token = textInput('optioneel', 'password');
    form.append(field('Exa API-key', inputs.token, 'Niet nodig. Zonder sleutel werkt het gratis met een limiet; kom je die tegen, maak dan een gratis account op exa.ai en plak de sleutel hier.'));
  } else {
    inputs.name = textInput('bijv. Notion');
    inputs.url = textInput('https://…/mcp', 'url');
    inputs.token = textInput('optioneel', 'password');
    inputs.headerName = textInput('Authorization');
    form.append(
      field('Naam', inputs.name),
      field('Adres (URL)', inputs.url, 'Het MCP-adres van de dienst. Vraagt die om inloggen, dan krijg je daarna een inlogknop.'),
      field('Sleutel of token', inputs.token, 'Alleen als de dienst een vaste sleutel gebruikt in plaats van inloggen.'),
    );
    const adv = node('details', 'mcp-adv');
    adv.append(node('summary', '', 'Andere header voor de sleutel'));
    adv.append(field('Header', inputs.headerName, 'Standaard Authorization (met Bearer ervoor).'));
    form.append(adv);
  }

  const actions = node('div', 'mem-actions');
  const submit = node('button', 'btn-primary', 'Koppelen');
  submit.type = 'submit';
  const msg = node('span', 'mem-muted');
  actions.append(submit, msg);
  form.append(actions);

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const body = { preset, origin: location.origin };
    for (const [k, i] of Object.entries(inputs)) body[k] = i.type === 'checkbox' ? i.checked : i.value.trim();
    // Supabase vraagt om inloggen: het tabblad nu al openen (anders blokkeert de browser het).
    // Bij andere servers verschijnt zo nodig een inlogknop in de lijst.
    const win = preset === 'supabase' && !body.token ? openAuthWindow() : null;
    submit.disabled = true;
    msg.textContent = 'Verbinden…';
    try {
      const r = await api('POST', '/api/mcp/servers', body);
      followAuth(win, r.server, null);
      await refreshMcp();
      renderMcpList();
    } catch (err) {
      if (win && !win.closed) win.close();
      msg.textContent = err.message;
      submit.disabled = false;
    }
  });

  box.append(form);
  const first = form.querySelector('input:not([type=checkbox])');
  if (first && !touch) first.focus();
}

el.mcpBtn.addEventListener('click', openMcp);
el.mcpClose.addEventListener('click', closeMcp);
el.mcpBack.addEventListener('click', () => {
  if (mcpView.mode === 'form' && el.mcpTitle.textContent !== 'MCP-server toevoegen') renderMcpChoose();
  else renderMcpList();
});
// Terug van het inlogtabblad.
window.addEventListener('message', (e) => {
  if (e.origin === location.origin && e.data?.type === 'mcp-auth') refreshMcp();
});
window.addEventListener('focus', () => { if (!el.mcpSheet.hidden) refreshMcp(); });
setInterval(() => {
  if (el.mcpSheet.hidden || mcpView.mode !== 'list') return;
  if ((state.mcp?.servers || []).some((s) => s.enabled && (s.status === 'connecting' || s.status === 'auth'))) refreshMcp();
}, 3000);

// ---------- Events ----------

el.composer.addEventListener('submit', (e) => {
  e.preventDefault();
  if (state.streaming) stop();
  else send();
});

el.input.addEventListener('input', () => {
  autosize();
  updateSlashMenu();
});
el.input.addEventListener('blur', () => setTimeout(hideSlashMenu, 150));
el.input.addEventListener('keydown', (e) => {
  if (!el.slashMenu.hidden && slash.items.length) {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const n = slash.items.length;
      slash.index = (slash.index + (e.key === 'ArrowDown' ? 1 : n - 1)) % n;
      updateSlashMenu();
      return;
    }
    if ((e.key === 'Enter' || e.key === 'Tab') && !e.isComposing) {
      e.preventDefault();
      pickSlash(slash.index);
      return;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      hideSlashMenu();
      return;
    }
  }
  if (e.key === 'Enter' && !e.shiftKey && !touch && !e.isComposing) {
    e.preventDefault();
    if (!state.streaming) send();
  }
});

el.newChat.addEventListener('click', () => {
  if (location.hash) location.hash = '';
  else showNewChat();
  closeNav();
});
el.menuBtn.addEventListener('click', () => el.app.classList.add('nav-open'));
el.scrim.addEventListener('click', closeNav);
el.chatList.addEventListener('click', (e) => { if (e.target.closest('a')) closeNav(); });
el.title.addEventListener('click', renameChat);
el.modelBtn.addEventListener('click', () => openPicker('chat'));
el.effortSel.addEventListener('change', () => {
  state.effort = el.effortSel.value;
  if (state.chat) api('PATCH', `/api/chats/${state.chat.id}`, { effort: state.effort }).catch(() => {});
});
el.pickerClose.addEventListener('click', closePicker);
el.picker.addEventListener('click', (e) => { if (e.target === el.picker) closePicker(); });
el.modelSearch.addEventListener('input', renderModelList);
el.modelSearch.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    // Anders belandt de Enter als lege regel in het berichtvak.
    e.preventDefault();
    const first = el.modelList.querySelector('.model-row .pick');
    if (first) first.click();
  }
});
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (!el.picker.hidden) closePicker();
  else if (!el.skillSheet.hidden) closeSkills();
  else if (!el.mcpSheet.hidden) closeMcp();
  else if (!el.memorySheet.hidden) closeMemory();
});

// Terug naar de app na een tijdje weg (telefoon): chat verversen.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible' || !state.chat) return;
  const last = state.messages[state.messages.length - 1];
  if (last && last.status === 'streaming') openChat(state.chat.id);
});

init().catch((err) => {
  el.messages.textContent = `Kon niet starten: ${err.message}`;
});
