# Ajouter des souvenirs depuis Immich

Les administrateurs d'un arbre disposant d'une connexion Immich peuvent utiliser
**Depuis Immich** dans **Ajouter des souvenirs**, ou dans les souvenirs d'un moment
de l'onglet **Vie**. Choisir Photos ou Vidéos, parcourir les pages puis sélectionner
un média. Dans un moment, plusieurs médias peuvent être sélectionnés avant de
terminer la sélection. Enregistrer ensuite le souvenir ou le moment.

Le sélecteur reprend la présentation de Parenthèse. Cliquer sur une photo ouvre
un aperçu agrandi avant de choisir le souvenir. La coche sous chaque vignette
permet aussi une sélection rapide. La recherche par contexte utilise la recherche
intelligente d'Immich (qui doit être activée et avoir indexé la photothèque).
Le filtre par visage utilise les personnes reconnues dans Immich, avec leur
portrait et une recherche par nom. Il peut être combiné au contexte. La clé doit
aussi disposer de `person.read` pour ce filtre et ses portraits.

Les fichiers sont copiés dans Parenthèse : ils restent disponibles indépendamment
d'Immich après l'enregistrement. Les limites existantes s'appliquent : 5 Mo par
photo, 20 Mo par vidéo et quota de l'arbre. Les formats pris en charge sont ceux
des envois locaux : JPEG, PNG, WebP, GIF ; MP4, MOV, WebM. Aucun transcodage des
originaux HEIC/RAW ni des codecs vidéo n'est ajouté.

La clé Immich doit disposer de `asset.read`, `asset.view` et `asset.download`, en
plus des permissions utilisées pour les portraits. Contrat :
[spécification officielle Immich](https://github.com/immich-app/immich/blob/main/open-api/immich-openapi-specs.json).

La photothèque est accessible uniquement aux administrateurs de l'arbre. La clé
et l'adresse Immich restent côté serveur ; la connexion utilise la liste
d'instances autorisées existante. Les téléchargements sont bornés en taille et
en durée, les redirections sont refusées et le type est vérifié dans les octets.
La persistance utilise l'API d'envoi existante : traitement des images, quota,
audit et association à la personne ou au moment. Aucune migration de base requise.

Cette fonction ne synchronise pas automatiquement les changements Immich et ne
déduplique pas les imports entre deux sessions. Une validation avec une instance
Immich réelle reste nécessaire avant déploiement.
