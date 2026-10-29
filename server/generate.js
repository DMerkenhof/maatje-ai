// Loopt een antwoord van het model af, los van de browser.
// Valt je telefoon in slaap of sluit je de tab, dan loopt het antwoord door
// en staat het er gewoon als je terugkomt. Alleen de stopknop breekt af.
import crypto from 'node:crypto';
import { streamChat, modelSupportsTools, localSupportsTools, isLocalModel, listModels } from './openrouter.js';
import { buildSystemPrompt, memoryReadTool, runMemoryRead } from './memory.js';
import * as mcp from './mcp.js';
import * as skills from './skills.js';

const active = new Map(); // chatId -> { controller, listeners, messageId, stopped, content, thinking, status, approval, toolLog }
let afterDone = () => {};

// Wordt aangeroepen na elk afgerond antwoord (voor het bijwerken van memory).
export function onGenerationDone(fn) {
  afterDone = fn;
}

export const isGenerating = (chatId) => active.has(chatId);

export function stopGeneration(chatId) {
  const g = active.get(chatId);
  if (!g) return false;
  g.stopped = true;
  g.controller.abort();
  return true;
}

const publicApproval = (a) => (a ? { id: a.id, server: a.server, tool: a.tool, title: a.title, args: a.args } : null);

// Wat er tot nu toe binnen is, voor wie halverwege meekijkt.
export function liveState(chatId) {
  const g = active.get(chatId);
  if (!g) return null;
  return {
    messageId: g.messageId,
    content: g.content,
    thinking: g.thinking && !g.content,
    status: g.status || null,
    approval: publicApproval(g.approval),
    tools: g.toolLog,
  };
}

export function subscribe(chatId, fn) {
  const g = active.get(chatId);
  if (!g) return null;
  g.listeners.add(fn);
  return () => g.listeners.delete(fn);
}

// Antwoord op "mag dit?": 'allow', 'always' of 'deny'.
export function answerApproval(chatId, approvalId, decision) {
  const g = active.get(chatId);
  if (!g?.approval || g.approval.id !== approvalId) return false;
  g.approval.finish(decision);
  return true;
}

const MAX_TOOL_ROUNDS = 8;
const APPROVAL_TIMEOUT = 15 * 60 * 1000;

const clip = (s, n) => {
  s = String(s ?? '');
  return s.length > n ? s.slice(0, n - 1).trimEnd() + '…' : s;
};

function argsForLog(args) {
  const json = JSON.stringify(args ?? {});
  return json.length <= 4000 ? args : clip(json, 4000);
}

function statusLabel(serverName, tool) {
  const n = tool.name.toLowerCase();
  if (/web_?search|search_web|^search$/.test(n)) return 'Zoekt op internet…';
  if (/web_?fetch|fetch_url|^fetch$|crawl|scrape/.test(n)) return 'Leest een webpagina…';
  if (n === 'execute_sql') return `${serverName}: query uitvoeren…`;
  if (n === 'list_tables') return `${serverName}: tabellen bekijken…`;
  return `${serverName}: ${tool.title || tool.annotations?.title || tool.name}…`;
}

// Uitleg in de systeemprompt over de MCP-servers die het model kan gebruiken.
function connectionsPrompt(servers, compact) {
  if (!servers.length) return '';
  const names = servers.map((s) => s.name).join(', ');
  const parts = [
    '## MCP',
    `Via tools kun je bij: ${names}. Gebruik ze als de vraag erom vraagt. Gaat het om iets actueels (nieuws, prijzen, openingstijden, wie ergens nu de baas is), zoek het dan eerst op als je een zoektool hebt, en noem je bronnen met een link. Tools die iets kunnen wijzigen vragen eerst toestemming aan de gebruiker; weigert die, doe het dan niet en vraag wat hij wil.`,
  ];
  if (!compact) {
    for (const s of servers) if (s.instructions) parts.push(`### ${s.name}\n${clip(s.instructions, 1200)}`);
  }
  return parts.join('\n\n');
}

function askApproval(g, emit, info) {
  return new Promise((resolve, reject) => {
    const id = crypto.randomUUID();
    let timer = null;
    const cleanup = () => {
      clearTimeout(timer);
      g.controller.signal.removeEventListener('abort', onAbort);
      g.approval = null;
    };
    const onAbort = () => {
      cleanup();
      reject(new Error('Gestopt'));
    };
    const finish = (decision) => {
      if (!g.approval || g.approval.id !== id) return;
      cleanup();
      g.status = null;
      emit({ type: 'approval_done', id, decision });
      resolve(decision);
    };
    timer = setTimeout(() => finish('timeout'), APPROVAL_TIMEOUT);
    g.controller.signal.addEventListener('abort', onAbort, { once: true });
    g.approval = { id, ...info, finish };
    g.status = 'Wacht op je toestemming…';
    emit({ type: 'approval', approval: publicApproval(g.approval) });
  });
}

export function startGeneration(store, chatId, model, { useMemory = true, effort = null } = {}) {
  const all = store.listMessages(chatId);
  const history = all
    // Mislukte antwoorden gaan niet mee als geschiedenis; gestopte wel.
    .filter((m) => (m.role === 'user' || m.role === 'assistant') && m.status !== 'error' && m.content.trim().length > 0)
    .map((m) => ({ role: m.role, content: m.content }));

  // De laatste paar gebruikersberichten bepalen welke memory-bestanden er meteen bij komen.
  const userTexts = all.filter((m) => m.role === 'user').map((m) => m.content);
  const recentText = userTexts.slice(-3).join('\n');
  const messageId = store.addMessage(chatId, { role: 'assistant', model, status: 'streaming' });

  const g = {
    controller: new AbortController(),
    listeners: new Set(),
    messageId,
    stopped: false,
    content: '',
    thinking: false,
    status: null,
    approval: null,
    toolLog: [],
  };
  active.set(chatId, g);

  const emit = (ev) => {
    for (const fn of g.listeners) {
      try { fn(ev); } catch {}
    }
  };
  const setStatus = (text) => {
    g.status = text;
    emit({ type: 'status', text });
  };

  (async () => {
    let content = '';
    let usage = null;
    let lastSave = Date.now();
    let thinkingSent = false;
    let memoryFiles = [];
    let usedSkills = [];
    let finalStatus = 'error';

    try {
      const local = isLocalModel(model);
      // Weten of het model tools kan gebruiken (lijst is na een herstart nog leeg).
      if (!local) {
        try { await listModels(); } catch {}
      }
      const canTools = local ? await localSupportsTools(model).catch(() => false) : modelSupportsTools(model);
      if (canTools) await mcp.ready();
      const conn = canTools ? mcp.toolsForModel({ compact: local }) : { tools: [], index: new Map(), servers: [] };

      // Lokale modellen krijgen de passende memory-bestanden direct mee (scheelt rondes op je Mac).
      const withMemoryTool = useMemory && canTools && !local;
      const system = buildSystemPrompt({ memory: useMemory, recentText, withTool: withMemoryTool, compact: local });
      memoryFiles = [...system.files];
      // Skills: met tools leest het model ze zelf; lokaal en zonder tools gaat een passende skill direct mee.
      const sk = skills.skillsPrompt({ userTexts, withTool: canTools, autoInclude: !canTools || local, compact: local });
      usedSkills = [...sk.used];
      const extra = [sk.text, connectionsPrompt(conn.servers, local)].filter(Boolean).join('\n\n');
      const messages = [{ role: 'system', content: extra ? `${system.text}\n\n${extra}` : system.text }, ...history];
      const hasSkills = sk.text.length > 0;
      const tools = [
        ...(withMemoryTool ? [memoryReadTool()] : []),
        ...(canTools && hasSkills ? [skills.skillReadTool()] : []),
        ...conn.tools,
      ];

      for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
        let calls = null;
        let roundText = '';
        const roundTools = tools.length && round < MAX_TOOL_ROUNDS ? tools : undefined;
        // Tekst van een eerdere ronde ("ik zoek het even op") niet tegen de nieuwe aan plakken.
        let needSep = content.length > 0;

        for await (const ev of streamChat({ model, messages, tools: roundTools, effort, signal: g.controller.signal })) {
          if (ev.type === 'delta') {
            const text = needSep ? `\n\n${ev.text}` : ev.text;
            needSep = false;
            content += text;
            roundText += ev.text;
            g.content = content;
            g.status = null;
            emit({ type: 'delta', text });
            // Tussendoor opslaan, zodat een herladen pagina het antwoord ziet groeien.
            if (Date.now() - lastSave > 1000) {
              store.updateContent(messageId, content);
              lastSave = Date.now();
            }
          } else if (ev.type === 'reasoning' && !thinkingSent && !content) {
            thinkingSent = true;
            g.thinking = true;
            emit(ev);
          } else if (ev.type === 'usage') {
            usage = addUsage(usage, ev.usage);
          } else if (ev.type === 'tool_calls') {
            calls = ev.calls;
          }
        }

        if (!calls || !calls.length) break;

        messages.push({
          role: 'assistant',
          content: roundText || '',
          tool_calls: calls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: c.arguments } })),
        });

        for (const c of calls) {
          let args = {};
          let argsOk = true;
          try { args = JSON.parse(c.arguments || '{}') || {}; } catch { argsOk = false; }
          let result = `Onbekende tool: ${c.name}`;

          if (c.name === 'memory_read') {
            setStatus('Geheugen lezen…');
            const r = runMemoryRead(args);
            result = r.text;
            for (const p of r.read) if (!memoryFiles.includes(p)) memoryFiles.push(p);
          } else if (c.name === 'skill_read') {
            setStatus('Skill lezen…');
            const r = skills.runSkillRead(args, { maxChars: local ? 40000 : 64000 });
            result = r.text;
            if (r.name && !usedSkills.includes(r.name)) usedSkills.push(r.name);
          } else if (conn.index.has(c.name)) {
            const { serverId, serverName, tool } = conn.index.get(c.name);
            const entry = { server: serverName, tool: tool.name, args: argsForLog(args) };
            g.toolLog.push(entry);

            if (!argsOk) {
              result = 'De argumenten waren geen geldige JSON. Probeer het opnieuw met geldige JSON.';
              entry.ok = false;
              entry.error = 'ongeldige argumenten';
            } else {
              let allowed = true;
              if (mcp.needsApproval(serverId, tool)) {
                const decision = await askApproval(g, emit, {
                  server: serverName,
                  tool: tool.name,
                  title: tool.title || tool.annotations?.title || '',
                  args: argsForLog(args),
                });
                entry.approval = decision;
                if (decision === 'always') mcp.setAutoApprove(serverId, tool.name, true);
                if (decision !== 'allow' && decision !== 'always') {
                  allowed = false;
                  result = decision === 'timeout'
                    ? 'De gebruiker heeft niet op tijd toestemming gegeven, dus dit is niet uitgevoerd. Zeg dat en vraag of het alsnog moet.'
                    : 'De gebruiker heeft dit geweigerd, dus het is niet uitgevoerd. Doe het niet alsnog; vraag eventueel wat hij wel wil.';
                  entry.ok = false;
                  entry.denied = true;
                }
              }
              if (allowed) {
                setStatus(statusLabel(serverName, tool));
                const started = Date.now();
                try {
                  const r = await mcp.callTool(serverId, tool.name, args, { signal: g.controller.signal, maxChars: local ? 6000 : 16000 });
                  result = r.isError ? `Fout van ${serverName}: ${r.text}` : r.text;
                  entry.ok = !r.isError;
                  entry.result = clip(r.text, 2000);
                } catch (err) {
                  if (g.stopped) throw err;
                  result = `De tool gaf een fout: ${err.message || err}`;
                  entry.ok = false;
                  entry.error = clip(err.message || String(err), 300);
                }
                entry.ms = Date.now() - started;
              }
            }
            emit({ type: 'tool', entry });
          }
          messages.push({ role: 'tool', tool_call_id: c.id, content: result, _name: c.name });
        }
      }

      if (!content.trim()) throw new Error('Het model gaf een leeg antwoord');
      store.finishMessage(messageId, { content, status: 'done', usage });
      finalStatus = 'done';
    } catch (err) {
      if (g.stopped) {
        store.finishMessage(messageId, { content, status: 'stopped', usage });
        finalStatus = 'stopped';
      } else {
        console.error(`[generate] ${model}: ${err.message || err}`);
        store.finishMessage(messageId, { content, status: 'error', error: err.message || String(err), usage });
      }
    } finally {
      store.setMeta(messageId, {
        memoryFiles,
        ...(effort && effort !== 'default' ? { effort } : {}),
        ...(g.toolLog.length ? { tools: g.toolLog } : {}),
        ...(usedSkills.length ? { skills: usedSkills } : {}),
      });
      store.touchChat(chatId);
      active.delete(chatId);
      if (finalStatus === 'done') {
        try { afterDone({ chatId, messageId }); } catch {}
      }
      emit({ type: 'done', message: store.getMessage(messageId) });
      g.listeners.clear();
    }
  })();

  return g;
}

function addUsage(a, b) {
  if (!a) return { ...b };
  const out = { ...a };
  for (const k of ['prompt_tokens', 'completion_tokens', 'total_tokens', 'cost']) {
    if (typeof b?.[k] === 'number') out[k] = (out[k] || 0) + b[k];
  }
  return out;
}
