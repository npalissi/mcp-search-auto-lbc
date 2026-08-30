---
name: leboncoin-vehicle-valuation
description: Normaliser les noms automobiles, analyser les descriptions d'annonces et estimer une cote française à partir de comparables Leboncoin. Utiliser pour toute demande de cote, valeur de marché ou recherche automobile comportant des critères précis.
---

# Leboncoin Vehicle Valuation

Utiliser les tools du MCP `mcp-search-auto-lbc`. Ne pas inventer de prix,
d'identifiant Leboncoin ou d'annonce lorsque le MCP est indisponible.

## Informations à extraire

Extraire de la demande la marque, le modèle, l'année et le kilométrage. Extraire
aussi, lorsqu'ils sont présents, la génération, le carburant, la motorisation,
la boîte et la finition. Conserver les libellés naturels fournis par
l'utilisateur : le résolveur se charge des codes internes.

Ne demander une précision que si une information indispensable manque ou si le
résolveur retourne plusieurs alternatives proches. Une motorisation ou une
finition absente n'empêche pas une première estimation, mais doit réduire la
précision annoncée.

## Catalogue Leboncoin

Le catalogue est synchronisé depuis les données utilisées par le frontend
Leboncoin. Ne pas inventer les codes de marque, modèle ou finition.

- Utiliser `list_leboncoin_vehicle_brands` pour confirmer une marque inconnue ou
  ambiguë.
- Utiliser `list_leboncoin_vehicle_models` avec une marque et une recherche
  ciblée pour distinguer des modèles proches, par exemple C3 et C3 Aircross.
- Utiliser `list_leboncoin_vehicle_trims` après résolution du modèle lorsqu'une
  finition précise change la sélection des comparables.
- Préférer des requêtes ciblées avec une petite limite au chargement de tout le
  catalogue dans le contexte du modèle.

## Résolution des identifiants

Appeler `resolve_leboncoin_vehicle` lorsque la marque ou le modèle est ambigu,
contient une génération (`Clio III`) ou lorsque les champs `leboncoinBrand` et
`leboncoinModel` ne sont pas déjà fiables.

- Avec `resolved: true` et une confiance d'au moins 80, réutiliser les valeurs
  exactes retournées.
- Avec une confiance inférieure à 80, signaler l'incertitude. Demander une
  précision seulement si les alternatives peuvent changer réellement le
  véhicule recherché.
- Ne jamais transformer soi-même `Clio 3` en `RENAULT_Clio_3` : la génération
  reste séparée du modèle Leboncoin.
- Si une finition a seulement été rapprochée d'une valeur du catalogue, conserver
  l'avertissement et la vérifier dans le texte de chaque annonce.

Pour construire ou diagnostiquer un payload brut, lire
[references/leboncoin-identifiers.md](references/leboncoin-identifiers.md).

## Filtres de recherche par défaut

Sauf demande contraire de l'utilisateur, rechercher uniquement les annonces de
particuliers avec `excludeProfessionalSellers: true`.

L'année demandée est un critère strict. Transmettre l'année exacte dans `year`
et ne jamais élargir automatiquement la recherche aux années voisines. Lorsque
`yearMin` et `yearMax` sont omis, le MCP utilise `year` comme borne basse et
borne haute et exclut aussi les annonces dont l'année est absente.

Utiliser `yearMin` et `yearMax` uniquement lorsque l'utilisateur demande
explicitement un intervalle ou plusieurs années. Toujours conserver dans `year`
l'année de référence, comprise dans cet intervalle. Exemple pour une cote 2021
acceptant volontairement les modèles de 2020 à 2022 :

```json
{
  "year": 2021,
  "yearMin": 2020,
  "yearMax": 2022
}
```

Ne jamais élargir cet intervalle parce que le volume d'annonces est faible. Le
signaler plutôt comme une limite de fiabilité. Dans la réponse, préciser
l'intervalle utilisé dès qu'il ne correspond pas à une année unique.

Pour ce projet, utiliser par défaut une zone de 200 km autour de Saintes. Si
l'utilisateur demande une autre ville ou un autre rayon, utiliser cette nouvelle
zone à la place :

```json
{
  "location": {
    "city": "Saintes",
    "latitude": 45.746,
    "longitude": -0.633,
    "radiusKm": 200
  }
}
```

## Lecture obligatoire des annonces

La lecture des annonces est indispensable, surtout lorsque l'utilisateur donne
des critères précis. Les filtres structurés servent à récupérer des candidats ;
ils ne remplacent pas la vérification du contenu.

- Appeler `estimate_used_vehicle` avec `includeDescriptions: true`. Utiliser
  `descriptionMaxChars: 5000` pour une recherche précise afin d'éviter qu'une
  information déterminante soit tronquée.
- Activer `includeImages: true` lorsqu'un critère peut nécessiter une
  confirmation visuelle. Une image ne prouve pas une caractéristique cachée ou
  illisible.
- Pour chaque comparable retenu, lire conjointement `title`, `characteristics`
  et `description`. Ne jamais décider à partir du titre seul.
- Avant l'analyse, distinguer les critères obligatoires, les motifs d'exclusion
  et les simples préférences. Vérifier notamment les mentions de société,
  nombre de places, finition, moteur, boîte, équipements, état, dommages,
  travaux, importation, batterie en location et TVA récupérable lorsqu'elles
  sont pertinentes pour la demande.
- Une caractéristique structurée explicite prime sur une formulation vague de
  la description. Une contradiction rend l'annonce incompatible ou au minimum
  incertaine et doit être signalée.
- L'absence d'une information n'est jamais une confirmation. Classer chaque
  annonce comme `confirmée`, `incompatible` ou `non confirmée` pour les critères
  demandés. Pour un critère obligatoire, ne conserver que les annonces
  confirmées ; pour une préférence, conserver séparément les cas non confirmés.
- Toujours appliquer d'abord les filtres natifs disponibles, notamment
  `excludeProfessionalSellers`, `excludeCompanyVehicles`, le carburant, la boîte
  et la finition, puis effectuer cette vérification sémantique.

Si cette lecture retire une part importante des comparables, ne pas présenter la
cote initiale comme si elle portait sur le sous-ensemble précis. Avec au moins
cinq annonces confirmées, recalculer une médiane et une fourchette à partir de
leurs prix. En dessous de cinq, présenter le résultat précis comme peu fiable et
distinguer clairement la cote générale du modèle.

## Estimation

Appeler `estimate_used_vehicle` avec les libellés naturels et, si disponibles,
les identifiants exacts issus du résolveur. Laisser le tool effectuer la
validation initiale, les exclusions natives et le calcul statistique. Effectuer
ensuite la lecture sémantique décrite ci-dessus pour toute contrainte spécifique.

Ne pas présenter le résultat comme une expertise garantie. Distinguer :

- la cote centrale ;
- la fourchette basse-haute ;
- le prix de vente rapide ;
- la confiance et le nombre de comparables ;
- les avertissements importants (moteur non confirmé, faible volume, forte
  dispersion ou source temporairement bloquée).

Si le tool retourne une erreur temporaire Leboncoin, proposer de réessayer plus
tard. Ne jamais remplacer cette erreur par une estimation issue des
connaissances générales du modèle.

## Réponse

Répondre dans la langue de l'utilisateur. Donner d'abord la cote et sa
fourchette, puis une justification courte basée sur les comparables. Mentionner
le nombre d'annonces confirmées, non confirmées et exclues lorsque des critères
précis ont été demandés. Mentionner les exclusions ou limites qui changent
matériellement l'interprétation. Fournir quelques liens d'annonces seulement
lorsqu'ils apportent une preuve utile ou que l'utilisateur les demande.
