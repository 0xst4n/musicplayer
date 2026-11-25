// Start page of the desktop app: remembers the server URL and opens it.
// "#change" in the URL (sent by Ctrl+Shift+S) shows the form instead of reconnecting.
const KEY = 'musicplayer.serverUrl';

const $ = (id) => document.getElementById(id);

function normalize(input) {
  let text = input.trim();
  if (!text) throw new Error('Enter a server address.');
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) text = `https://${text}`;
  const url = new URL(text);
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('Use an http:// or https:// address.');
  url.hash = '';
  return url.href;
}

async function reachable(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  try {
    // no-cors: we only need to know the server answers, not read the response.
    await fetch(url, { mode: 'no-cors', cache: 'no-store', signal: ctrl.signal });
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

function showForm(url, error) {
  $('connecting').hidden = true;
  $('form').hidden = false;
  $('url').value = url || '';
  $('error').textContent = error || '';
  $('error').hidden = !error;
  $('url').focus();
  $('url').select();
}

async function connect(url) {
  $('form').hidden = true;
  $('connecting').hidden = false;
  $('connecting-url').textContent = new URL(url).host;
  if (await reachable(url)) {
    localStorage.setItem(KEY, url);
    location.replace(url);
  } else {
    showForm(url, `Could not reach ${new URL(url).host}. Check the address and that the server is running.`);
  }
}

$('form').addEventListener('submit', (e) => {
  e.preventDefault();
  try {
    connect(normalize($('url').value));
  } catch (err) {
    showForm($('url').value, err.message);
  }
});

function start() {
  const saved = localStorage.getItem(KEY);
  if (saved && location.hash !== '#change') connect(saved);
  else showForm(saved);
}

window.addEventListener('hashchange', start);
start();
