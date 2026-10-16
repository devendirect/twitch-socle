/**
 * Seule façon d'écrire du texte dans une page (section 7 du brief).
 *
 * Un pseudo ou un texte venu du chat ne passe JAMAIS par `innerHTML` : un
 * spectateur nommé `<img src=x onerror=…>` exécuterait son script dans OBS.
 * `textContent` n'interprète rien. Un test analyse `public/` et échoue s'il
 * trouve `innerHTML` hors de la liste blanche.
 */

/** Longueurs affichées : pseudo 25 caractères, tout autre texte du chat 40. */
export const PSEUDO_MAX = 25;
export const TEXTE_MAX = 40;

/** Coupe à `max` caractères (points de code), avec « … ». */
export function nettoyer(valeur, max = TEXTE_MAX) {
  const lettres = [...String(valeur ?? '')];
  return lettres.length <= max ? lettres.join('') : `${lettres.slice(0, max - 1).join('')}…`;
}

/** Écrit `valeur` comme texte dans `el`, coupé à `max`. Renvoie `el`. */
export function texte(el, valeur, max = TEXTE_MAX) {
  el.textContent = nettoyer(valeur, max);
  return el;
}

/** Crée un élément, avec classe et texte éventuels. */
export function element(balise, classe, valeur, max) {
  const el = document.createElement(balise);
  if (classe) el.className = classe;
  if (valeur !== undefined) texte(el, valeur, max);
  return el;
}

/** Remplace les enfants de `parent` (sans `innerHTML = ''`). */
export function remplacer(parent, ...enfants) {
  parent.replaceChildren(...enfants);
  return parent;
}
