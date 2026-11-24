// Aplica el tema guardado antes de pintar la página (evita un parpadeo)
try {
  const t = localStorage.getItem('agenda_tema');
  if (t === 'light' || t === 'dark') document.documentElement.dataset.theme = t;
} catch {}
