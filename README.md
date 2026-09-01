# GE-DESIGN Personas Builder - Plugin Figma

Genere une instance de composant (ou un clone de frame) par ligne d'un CSV, en remplissant
automatiquement les calques texte dont le nom correspond a une colonne (comparaison
insensible a la casse).

## Structure

```
ge-personas-builder/
├── manifest.json        # Manifest du plugin (point d'entree code.js / ui.html)
├── src/code.ts           # Source TypeScript du thread principal (sandbox Figma)
├── code.js                # Version compilee, chargee par Figma (deja generee, prete a l'emploi)
├── ui.html                # UI du plugin (upload/collage CSV, mapping, generation)
├── package.json / tsconfig.json  # Tooling de build TypeScript
└── README.md
```

`code.js` est deja compile : le plugin est utilisable tel quel, sans etape de build.
Si vous modifiez `src/code.ts`, recompilez avec :

```bash
npm install
npm run build      # regenere code.js a partir de src/code.ts
```

## Installation locale (Figma desktop)

1. Menu Figma → **Plugins** → **Development** → **Import plugin from manifest…**
2. Selectionner `manifest.json` dans ce dossier.
3. Le plugin apparait dans **Plugins → Development → GE-DESIGN Personas Builder**.

## Utilisation

1. **Selectionner le gabarit** : dans le canvas, selectionner un unique composant,
   instance, frame ou groupe servant de carte modele (ex. carte persona). Le plugin lit
   en continu la selection et liste les calques texte trouves.
2. **Lancer le plugin**, puis **importer le CSV** : glisser/choisir un fichier `.csv`, ou
   coller son contenu directement dans la zone de texte.
   - Le delimiteur (`,` ou `;`) est detecte automatiquement — utile pour les exports Excel
     francophones qui utilisent le point-virgule.
   - La premiere ligne est toujours traitee comme les en-tetes de colonnes.
3. **Verifier le mapping** : chaque calque texte du gabarit s'affiche en vert (colonne
   trouvee) ou en rouge (aucune colonne correspondante — le calque gardera son contenu par
   defaut). Un apercu des 5 premieres lignes du CSV est affiche.
4. **Regler la disposition** : nombre d'instances par ligne de grille, espacements
   horizontal/vertical (en px).
5. **Generer** : le plugin cree une instance par ligne du CSV, positionnee en grille sous
   le gabarit d'origine, puis affiche un resume (nombre d'instances creees, colonnes non
   mappees, calques sans correspondance).

## Sliders dynamiques

En plus des calques texte, le plugin sait deplacer un curseur de slider (le rond) le long
de son rail, a partir d'une valeur numerique lue en CSV.

**Convention a appliquer sur le gabarit** (une seule fois, avant generation) :

- Renommer le calque du curseur (l'ellipse/forme mobile) avec le prefixe `slider:` suivi
  du nom de la colonne CSV, ex. `slider:utilisation_memia`.
- Le **parent direct** de ce calque doit etre le rail (track) — sa largeur definit
  l'amplitude de deplacement. Si le rail actuel contient aussi les libelles ("Rare" /
  "Frequente"), il faut isoler le curseur + le rail dans leur propre frame pour que la
  largeur mesuree soit la bonne.
- La colonne CSV correspondante contient une valeur **numerique de 0 a 100**
  (0 = butee gauche, 100 = butee droite). Les libelles textuels aux extremites restent
  fixes (edites a la main), seule la position du curseur est dynamisee.
- Si le rail est en auto-layout, le plugin bascule automatiquement le curseur en
  positionnement absolu (`layoutPositioning = "ABSOLUTE"`) pour pouvoir le deplacer
  librement, sans toucher au reste de la mise en page.
- Valeur vide dans le CSV -> le curseur garde sa position par defaut. Valeur non
  numerique ou rail trop etroit pour le curseur -> comptabilise dans les "valeurs de
  slider invalides" du resume, la generation continue pour les autres calques/lignes.

Cette convention est volontairement simple pour un usage en mode POC. Si les echelles
deviennent plus riches (min/max variables par slider, sens inverse, etc.), on pourra
etendre le format de colonne (ex. `slider:utilisation_memia:0:5` pour une echelle 0-5)
sans casser la logique existante.

## Comportement sur les cas limites

- **Colonne vide pour une ligne donnee** → le calque texte correspondant est vide
  (`characters = ""`), la generation ne s'interrompt pas.
- **Calque texte sans colonne correspondante** → son contenu par defaut (celui du
  gabarit) est conserve tel quel.
- **Aucune colonne ne correspond a aucun calque** → la generation est bloquee et un
  message d'erreur explicite est affiche dans l'UI.
- **Erreur sur une ligne particuliere** (police manquante, etc.) → la ligne est ignoree,
  comptabilisee dans `errorRows`, et la generation continue pour les lignes suivantes
  (voir la console du plugin pour le detail).
- **Polices mixtes dans un calque texte** : chaque plage de caracteres est detectee et
  sa police chargee individuellement avant toute modification de `characters`
  (`figma.loadFontAsync` est toujours appele avant ecriture, conformement a l'API Figma).
- **Gabarit de type `COMPONENT_SET`** : la premiere variante est utilisee comme modele
  effectif (`createInstance()` sur cette variante).

## Notes techniques

- Parseur CSV interne (sans dependance externe) : gere les champs entre guillemets, les
  guillemets echappes (`""`), les retours a la ligne `\r\n`/`\n`, et detecte automatiquement
  le delimiteur `,`/`;` a partir de la premiere ligne.
- Le mapping colonne ↔ calque est recalcule cote thread principal a partir du nom de
  chaque calque `TEXT` trouve recursivement dans le gabarit (`node.type === "TEXT"`,
  parcours de `children` recursif).
- Duplication : `component.createInstance()` pour un `COMPONENT`/`COMPONENT_SET`,
  `node.clone()` pour une `FRAME`, un `GROUP` ou une `INSTANCE`.
- Aucun acces reseau requis (`networkAccess.allowedDomains: ["none"]` dans le manifest) —
  tout le traitement CSV se fait cote client dans l'UI du plugin.
