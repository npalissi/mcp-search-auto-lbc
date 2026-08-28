---
name: leboncoin-vehicle-valuation
description: Normaliser les noms automobiles pour les filtres Leboncoin et estimer une cote française à partir d'annonces comparables. Utiliser pour toute demande de cote, valeur de marché ou recherche de comparables d'un véhicule d'occasion sur Leboncoin.
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

Pour construire ou diagnostiquer un payload brut, lire
[references/leboncoin-identifiers.md](references/leboncoin-identifiers.md).

## Filtres de recherche par défaut

Sauf demande contraire de l'utilisateur, rechercher uniquement les annonces de
particuliers avec `excludeProfessionalSellers: true`.

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

## Estimation

Appeler `estimate_used_vehicle` avec les libellés naturels et, si disponibles,
les identifiants exacts issus du résolveur. Laisser le tool effectuer la
validation finale, les exclusions et le calcul statistique.

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
les exclusions ou limites qui changent matériellement l'interprétation. Fournir
quelques liens d'annonces seulement lorsqu'ils apportent une preuve utile ou que
l'utilisateur les demande.
