import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * Vérification réutilisable par chaque jeu dans ses tests (section 7, point 9
 * du brief) : aucun texte venu du chat ou d'une API ne doit passer par
 * `innerHTML`. On cherche les quatre façons d'écrire du HTML brut dans les
 * pages et scripts de `public/`, commentaires retirés.
 *
 * @param liste blanche : `chemin relatif → raison`, pour un usage justifié
 * @returns les usages trouvés hors liste blanche, `fichier:ligne : extrait`
 */
export function chercherHtmlBrut(dossier: string, listeBlanche: Readonly<Record<string, string>> = {}): string[] {
  const motifs = /\b(innerHTML|outerHTML|insertAdjacentHTML|document\.write)\b/;
  const trouves: string[] = [];

  const visiter = (courant: string) => {
    for (const entree of readdirSync(courant, { withFileTypes: true })) {
      const complet = path.join(courant, entree.name);
      if (entree.isDirectory()) {
        if (entree.name !== 'vendor' && entree.name !== 'node_modules') visiter(complet);
        continue;
      }
      if (!/\.(html|js|mjs)$/.test(entree.name)) continue;
      const relatif = path.relative(dossier, complet).split(path.sep).join('/');
      if (relatif in listeBlanche) continue;

      // Commentaires remplacés par des espaces : les numéros de ligne restent justes.
      const source = readFileSync(complet, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, (bloc) => bloc.replace(/[^\n]/g, ' '))
        .replace(/(^|[^:])\/\/[^\n]*/g, (ligne, debut: string) => debut + ' '.repeat(ligne.length - debut.length));
      source.split('\n').forEach((ligne, i) => {
        if (motifs.test(ligne)) trouves.push(`${relatif}:${i + 1} : ${ligne.trim()}`);
      });
    }
  };
  visiter(dossier);
  return trouves;
}
