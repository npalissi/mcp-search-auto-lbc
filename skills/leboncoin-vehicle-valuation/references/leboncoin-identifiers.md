# Identifiants automobiles Leboncoin

Le filtre automobile de la marketplace utilise les clés suivantes :

| Information | Clé | Exemple |
|---|---|---|
| Marque | `u_car_brand` | `RENAULT` |
| Modèle | `u_car_model` | `RENAULT_Clio` |
| Énergie | `fuel` | `2` |
| Boîte | `gearbox` | `1` |
| Année | `regdate` | plage min/max |
| Kilométrage | `mileage` | plage min/max |

La marque est généralement en majuscules. Le modèle contient l'identifiant de
marque, un underscore, puis le libellé avec la casse Leboncoin :
`PEUGEOT_208`, `VOLKSWAGEN_Golf`, `TESLA_Model 3`.

La génération et la motorisation ne doivent pas être ajoutées arbitrairement à
`u_car_model`. `Clio III 1.5 dCi` se décompose ainsi :

```json
{
  "u_car_brand": "RENAULT",
  "u_car_model": "RENAULT_Clio",
  "generation": "3",
  "engine": "1.5 dCi"
}
```

Codes principaux : énergie `1` essence, `2` diesel, `4` électrique, `6`
hybride, `8` hybride rechargeable ; boîte `1` manuelle et `2` automatique.

Exemple de filtres finder :

```json
{
  "category": { "id": "2" },
  "enums": {
    "ad_type": ["offer"],
    "u_car_brand": ["RENAULT"],
    "u_car_model": ["RENAULT_Clio"],
    "fuel": ["2"],
    "gearbox": ["1"]
  },
  "ranges": {
    "regdate": { "min": 2009, "max": 2011 },
    "mileage": { "min": 70000, "max": 130000 }
  }
}
```

Les attributs d'annonces `u_car_brand`, `u_car_model` et `u_car_version` sont la
source de vérité dynamique. Préférer les valeurs observées et validées par le
résolveur aux identifiants devinés.
