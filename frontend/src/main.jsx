import React from 'react';
import ReactDOM from 'react-dom/client';
import { THEMES, getTheme } from './theme';

const theme = getTheme();
document.documentElement.dataset.theme = theme;

const fonts = document.createElement('link');
fonts.rel = 'stylesheet';
fonts.href = THEMES.find((t) => t.id === theme).fonts;
document.head.appendChild(fonts);

const loadTheme = {
  dark: () => import('./themes/place'),
  based: () => import('./themes/place'),
};

// After a deploy, a tab opened before it asks for script files that no longer exist. Reload once to get the new ones.
// The reload is remembered in sessionStorage; without it (blocked storage) there is no reload, so it can never loop.
window.addEventListener('vite:preloadError', (event) => {
  try {
    const last = Number(sessionStorage.getItem('place_chunk_reload') || 0);
    if (Date.now() - last < 30000) return; // already reloaded just now: show the error instead of looping
    sessionStorage.setItem('place_chunk_reload', String(Date.now()));
  } catch (e) {
    return;
  }
  event.preventDefault();
  window.location.reload();
});

loadTheme[theme]().then(({ default: App }) => {
  ReactDOM.createRoot(document.getElementById('root')).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>
  );
});
