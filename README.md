# Présence cours — kiosque

Prise de présence pour les cours de danse de Julio chez Bachata Geneva Dance Studio.
Une tablette posée en salle, l'élève coche son nom, les présences partent dans le
Google Sheet de l'école en fin de cours.

Contexte, décisions et questions ouvertes : fiche du hub `projets/presence-cours.md`.

## Comment ça tient debout

Les deux classeurs appartiennent à l'école et sont partagés **en édition** avec
`julio@paniagua.dev`. Le back-end est un **Apps Script déployé en web app**, exécuté
sous ce compte : il hérite des droits sans qu'aucun secret Google n'existe côté projet.
Pas de compte de service, pas de jeton OAuth, rien à héberger.

## Structure des classeurs

Le parseur ne connaît **aucune adresse fixe**. Il repère les blocs par leur titre et
déduit tout le reste. C'est volontaire : la grille est tenue à la main par l'école et
bouge d'une saison à l'autre.

Un onglet est une pile de **sections**, une par cours (`Julio & Diana - Inter-Avancé 1`).
Une section se lit en deux moitiés indépendantes : **leaders à gauche, followers à
droite**. Chaque moitié empile trois blocs :

| Bloc | `category` |
|------|-----------|
| `Leaders / Followers actifs` | `active` |
| `Essais Leader / Follower` | `trial` |
| `Aide Leader / Follower` | `helper` |

Sous chaque titre de bloc : une ligne d'en-tête `N° | Nom | <dates…> | Commentaires`,
puis des lignes numérotées. **Une ligne numérotée sans nom est une place libre** — c'est
là qu'un élève d'essai non listé est inscrit.

Pièges que le code traite explicitement :

- **Les deux moitiés ont des colonnes différentes** (dates en D-I à gauche, N-S à droite)
  mais **les mêmes numéros de ligne**. Une ligne n'a de sens que dans son bloc : le code
  ne cherche jamais une ligne à l'échelle du cours.
- **Les lignes de totaux sont des formules.** Seules les cellules des lignes nommées sont
  écrites, jamais une ligne de structure.
- **Le nombre de lignes par bloc n'est pas constant** (7 le plus souvent, 9 observé).
  La lecture s'arrête quand la colonne `N°` cesse de contenir un nombre.
- **Les en-têtes de dates sont tantôt de vraies dates, tantôt du texte.** Les deux sont
  ramenés à une clé `MM-JJ` ; le millésime est ignoré, une saison va d'août à juin.

## API

Réponse toujours en HTTP 200 avec un drapeau `ok` — Apps Script ne permet pas de choisir
le code de statut.

### `GET ?token=…&date=AAAA-MM-JJ`

`date` est optionnelle et vaut aujourd'hui. Renvoie tous les cours des deux classeurs :

```json
{
  "ok": true,
  "date": "2026-08-25",
  "courses": [{
    "id": "<idClasseur>::<onglet>::<ligneDuTitre>",
    "title": "Julio & Diana - Inter-Avancé 1",
    "hasSession": true,
    "sessionLabels": ["25.08", "1.09", "…"],
    "groups": [{
      "key": "leader:active",
      "role": "leader", "category": "active",
      "nameColumn": 3, "sessionColumn": 4,
      "students": [{ "row": 12, "number": 1, "name": "…", "present": false }],
      "freeSlots": [{ "row": 15, "number": 4 }]
    }]
  }]
}
```

`hasSession: false` signifie qu'aucune colonne ne correspond à la date : l'app doit le
dire, pas écrire ailleurs.

### `POST`

```json
{
  "token": "…",
  "courseId": "…",
  "date": "2026-08-25",
  "marks": [{ "group": "leader:active", "row": 12, "name": "…", "present": true }],
  "additions": [{ "role": "follower", "name": "Prénom N.", "present": true }]
}
```

Le classeur est **relu au moment de l'écriture**. Une marque n'est appliquée que si le
nom présent à cette ligne est toujours celui que le kiosque croyait : sinon elle part
dans `rejected` avec sa raison. Rien n'est deviné. Les absents sont écrits `FALSE`.

`marks` doit porter `group` : sans lui une ligne est ambiguë entre leader et follower.

## Déploiement

1. Créer un projet Apps Script **autonome** sur `julio@paniagua.dev`
   (script.google.com → Nouveau projet), y coller `apps-script/Code.gs` et le contenu de
   `apps-script/appsscript.json`.
2. Paramètres du projet → Propriétés du script → ajouter `KIOSK_TOKEN` avec une valeur
   longue et aléatoire. **Sans elle le script refuse toute requête.**
3. Déployer → Nouveau déploiement → Application web :
   « Exécuter en tant que **moi** », « Accès : **tout le monde** ».
   L'accès anonyme est nécessaire — la tablette n'est pas connectée à un compte Google.
   C'est le `KIOSK_TOKEN` qui protège l'écriture, pas la connexion.
4. Ranger l'URL du déploiement dans `pass` :
   `pass insert projets/presence-cours/apps-script-url`, et le jeton dans
   `pass insert projets/presence-cours/kiosk-token`. **Ni l'un ni l'autre dans le dépôt.**

L'URL de déploiement vaut droit d'écriture : la traiter comme un secret.

## Tests

```sh
npm test
```

Les tests chargent `Code.gs` dans un contexte `vm` avec des bouchons Apps Script, et le
font tourner sur des grilles reconstruites à l'identique des vrais classeurs — **avec des
noms inventés**. La liste réelle des élèves de l'école n'entre pas dans ce dépôt.
