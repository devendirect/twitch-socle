/**
 * Client SSE minimal de l'overlay : se connecte à `/events`, se reconnecte
 * seul (le navigateur retente après 2 s), et appelle `render(vue)` à chaque
 * état. Le premier état arrive dès la connexion : une source OBS relancée en
 * pleine manche s'affiche aussitôt.
 */
export function live(render, { url = '/events', surEtat } = {}) {
  const source = new EventSource(url);
  source.addEventListener('state', (event) => {
    let vue;
    try {
      vue = JSON.parse(event.data);
    } catch {
      return;
    }
    render(vue);
  });
  if (surEtat) {
    source.addEventListener('open', () => surEtat('connecte'));
    source.addEventListener('error', () => surEtat('reconnexion'));
  }
  return () => source.close();
}
