// Sign-in page script (a separate file so the Content Security Policy can forbid inline scripts).
document.getElementById('f').onsubmit = async (ev) => {
  ev.preventDefault();
  const r = await fetch('/api/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: ev.target.password.value }),
  });
  if (r.ok) location.replace('/');
  else document.getElementById('e').textContent = (await r.json().catch(() => ({}))).error || 'Sign in failed';
};
