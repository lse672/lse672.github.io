# Échéancier de prêt — éditeur Standard Notes

Portage de `echeancier_panel_v4.md` (Python / Panel) en éditeur Standard Notes autonome
(HTML + JavaScript, aucune dépendance réseau : tout est dans `lib/`).

## Contenu

```
Echeancier/
├── index.html              l'éditeur (calcul, interface, graphiques, rappels théoriques)
├── ext.json                description du plugin pour Standard Notes
└── lib/
    ├── component-relay.js  @standardnotes/component-relay 2.2.2 (dialogue avec l'application)
    └── katex/              KaTeX 0.19.1 (formules des rappels théoriques)
```

## Installation

1. Copier le dossier `Echeancier/` à la racine du dépôt `Standard_Notes_plugins`, puis pousser.
2. Vérifier que `https://lse672.github.io/Standard_Notes_plugins/Echeancier/ext.json` répond.
3. Standard Notes → Préférences → Plugins → *Install custom plugin* → coller l'URL de `ext.json`.
4. Créer une note, choisir l'éditeur « Échéancier de prêt ».

Si le dépôt ou le dossier porte un autre nom, adapter `url` et `latest_url` dans `ext.json`.

## Stockage

La note contient un JSON lisible :

```json
{ "type": "echeancier-pret", "version": 1,
  "params": { "capital": 100000, "duree": 25, "taux": 3.75, "inflation": 2,
              "periodicite": 12, "typeAmort": "annuite", "methode": "proportionnel" },
  "notes": "texte libre" }
```

Le tableau est recalculé à l'ouverture (rien de volumineux n'est synchronisé).
L'aperçu de la liste des notes affiche le résumé du prêt (capital, durée, taux, échéance).
Si l'éditeur est appliqué à une note contenant du texte ordinaire, ce texte est repris dans
« Remarques » et n'est pas perdu. Une note verrouillée n'est jamais modifiée.

## Différences avec la version Panel

- Le graphique à deux axes est scindé en deux graphiques à un seul axe (versements annuels ;
  capital restant dû nominal / en euros constants), plus lisibles.
- Ajout d'un champ « Remarques » et d'un bouton « Copier le CSV » (le téléchargement de
  fichiers peut être bloqué dans l'application mobile).
- Sur petit écran, les colonnes en euros constants sont masquées par défaut (case à cocher).
- Calculs vérifiés identiques au code Python (écart < 1e-10 €) sur 5 combinaisons de paramètres.

## Mettre à jour

Modifier `index.html`, incrémenter `version` dans `ext.json`, pousser.
