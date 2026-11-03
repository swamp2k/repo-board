import assert from 'node:assert/strict';
import vm from 'node:vm';
import { t3Panel, t3ClientConfig } from '../src/t3-ui.js';

// Exercise the actual embedded client with a small DOM and controlled network.
// This verifies lifecycle behavior; it does not claim real-browser layout coverage.
class Element {
  constructor() { this.children = []; this.dataset = {}; this.listeners = {}; this.value = ''; }
  append(child) { this.children.push(child); if (!this.value && child.value) this.value = child.value; }
  replaceChildren() { this.children = []; }
  setAttribute() {}
  addEventListener(name, handler) { this.listeners[name] = handler; }
  get selectedOptions() { return this.children.filter(c => c.value === this.value); }
  showModal() { this.open = true; }
}
const ids = ['t3-dialog','t3-repo','t3-sessions','t3-status','t3-prompt','t3-new','t3-config','t3-github','t3-now'];
const elements = Object.fromEntries(ids.map(id => [id, new Element()]));
elements['t3-config'].textContent = JSON.stringify({ repositories: [{ githubId: 10, name: 'owner/repo', url: 'https://github.com/owner/repo', inspectionPrompt: 'Read NOW.md', now: { state: 'paused' } }] });
const document = { getElementById: id => elements[id], createElement: () => new Element(), addEventListener(name, fn) { this[name] = fn; } };
let complete;
let timers = [];
const saved = new Map([['t3-selected-10', 'mock-existing']]);
vm.runInNewContext(t3Panel().match(/<script>([\s\S]*)<\/script>/)[1], {
  document, AbortController, crypto, localStorage: { getItem: k => saved.get(k), setItem: (k,v) => saved.set(k,v) },
  setTimeout(fn) { timers.push(fn); return fn; }, clearTimeout(fn) { timers = timers.filter(t => t !== fn); },
  fetch: () => new Promise(resolve => { complete = resolve; }),
});
const click = () => document.click({ target: { closest: () => ({ dataset: { t3Repo: '10' } }) } });
const flush = async () => { for (let i=0;i<10;i++) await Promise.resolve(); };
click();
assert.equal(elements['t3-dialog'].open, true);
assert.equal(elements['t3-github'].href, 'https://github.com/owner/repo');
assert.match(elements['t3-now'].textContent, /paused/);
// A response arriving after close must not restart polling.
elements['t3-dialog'].open = false;
elements['t3-dialog'].listeners.close();
complete(new Response(JSON.stringify({ sessions: [], repository: { name: 'owner/repo' } })));
await flush();
assert.equal(timers.length, 0);
click();
complete(new Response(JSON.stringify({ sessions: [{ id: 'mock-existing', title: 'Inspection', status: 'completed', updatedAt: 'today', messages: [{ role: 'assistant', content: '[SIMULATED]' }] }], repository: { name: 'owner/repo' } })));
await flush();
assert.equal(elements['t3-sessions'].children.length, 1);
assert(elements['t3-sessions'].children[0].children.some(c => c.textContent === 'assistant: [SIMULATED]'));
assert.equal(timers.length, 1);
elements['t3-dialog'].open = false;
elements['t3-dialog'].listeners.close();
assert.equal(timers.length, 0);
const encoded = t3ClientConfig([{ name: '</script><img>' }]);
assert.equal(encoded.match(/<\/script>/g).length, 1);
assert.equal(JSON.parse(encoded.match(/>(.*)<\/script>/)[1]).repositories[0].name, '</script><img>');
console.log('T3 client close/reopen, selection restoration and escaping ok');
