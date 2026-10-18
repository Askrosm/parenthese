import { API_BASE_URL, apiRequest } from './client.js'

// Reconnaissance des visages : la connexion Immich est propre à chaque arbre, configurée par
// ses administrateurs. L'adresse est choisie parmi celles autorisées par l'opérateur du
// serveur ; la clé d'API ne quitte jamais le backend. Les erreurs distinguent non configuré /
// injoignable / clé refusée.

function withAuth(options = {}, token) {
  if (!token) return options
  return { ...options, headers: { ...(options.headers || {}), Authorization: `Bearer ${token}` } }
}

export function getImmichErrorMessage(error, t) {
  const code = error?.payload?.error || ''
  if (code === 'immich_asset_too_large') return t('Fichier trop volumineux (photo : 5 Mo, vidéo : 20 Mo).')
  if (code === 'immich_asset_not_found') return t('Média introuvable dans Immich.')
  if (code === 'invalid_immich_media') return t('Format de média non pris en charge.')
  if (code === 'immich_not_configured') return t('Immich n’est pas configuré pour cet arbre.')
  if (code === 'immich_unreachable') return t('Immich est injoignable.')
  if (code === 'immich_auth_failed') return t('La clé d’accès à Immich a été refusée.')
  if (code === 'immich_person_not_found') return t('Personne introuvable dans Immich.')
  if (code === 'invalid_immich_person_id') return t('Identifiant Immich invalide.')
  if (code === 'invalid_avatar_image') return t('La vignette Immich n’est pas une image valide.')
  if (code === 'storage_quota_exceeded') return t('Espace disque de l’arbre dépassé.')
  if (code === 'api_key_required') return t('Indiquez la clé d’accès à Immich pour la première configuration.')
  if (code === 'instance_not_allowed') return t('Cette instance Immich n’est pas autorisée par l’opérateur du serveur.')
  if (code === 'forbidden') return t('Seuls les administrateurs de l’arbre peuvent associer un visage Immich.')
  if (error?.status === 0 || error?.message === 'Failed to fetch') return t('Immich est injoignable.')
  return error?.message || t('Erreur inattendue.')
}

export function listImmichAssets(treeId, token, page = 1, type = 'IMAGE', { query, personId, signal } = {}) {
  const search = new URLSearchParams({ page: String(page), type })
  if (query?.trim()) search.set('q', query.trim())
  if (personId) search.set('personId', personId)
  return apiRequest(`/trees/${encodeURIComponent(treeId)}/immich/assets?${search}`, withAuth({ signal }, token))
}

export async function fetchImmichAsset(treeId, assetId, token, variant = 'thumbnail', signal) {
  const response = await fetch(`${API_BASE_URL}/trees/${encodeURIComponent(treeId)}/immich/assets/${encodeURIComponent(assetId)}/${variant}`, {
    headers: { Authorization: `Bearer ${token}` }, signal,
  })
  if (!response.ok) {
    const error = new Error('immich_asset_failed')
    error.status = response.status
    error.payload = await response.json().catch(() => ({}))
    throw error
  }
  return response.blob()
}

// Connexion Immich de l'arbre : métadonnées sûres (jamais la clé, jamais l'adresse) et instances
// autorisées par l'opérateur, nommées par leur libellé, dont le panneau d'administration fait un menu.
export async function fetchImmichConfig(treeId, token) {
  const data = await apiRequest(`/trees/${encodeURIComponent(treeId)}/immich/config`, withAuth({}, token))
  return {
    config: data?.config || { configured: false, instanceId: null, label: null, updatedAt: null },
    instances: Array.isArray(data?.instances) ? data.instances : [],
  }
}

export async function saveImmichConfig(treeId, { instanceId, apiKey }, token) {
  const data = await apiRequest(`/trees/${encodeURIComponent(treeId)}/immich/config`, withAuth({
    method: 'PUT',
    body: JSON.stringify({ instanceId, ...(apiKey ? { apiKey } : {}) }),
  }, token))
  return data?.config || null
}

export async function removeImmichConfig(treeId, token) {
  return apiRequest(`/trees/${encodeURIComponent(treeId)}/immich/config`, withAuth({
    method: 'DELETE',
  }, token))
}

export async function checkImmichStatus(treeId, token) {
  return apiRequest(`/trees/${encodeURIComponent(treeId)}/immich/status`, withAuth({}, token))
}

export async function listImmichPeople(treeId, token) {
  const data = await apiRequest(`/trees/${encodeURIComponent(treeId)}/immich/people`, withAuth({}, token))
  return Array.isArray(data?.people) ? data.people : []
}

// Personne Immich déjà associée à cette fiche (administrateurs seulement), ou null.
export async function fetchImmichLink(treeId, personId, token) {
  const data = await apiRequest(`/trees/${encodeURIComponent(treeId)}/immich/links/${encodeURIComponent(personId)}`, withAuth({}, token))
  return data?.immichPersonId || null
}

export async function fetchImmichThumbnail(treeId, immichPersonId, token) {
  const path = `/trees/${encodeURIComponent(treeId)}/immich/thumbnail/${encodeURIComponent(immichPersonId)}`
  const response = await fetch(`${API_BASE_URL}${path}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  })
  if (!response.ok) {
    throw new Error(`immich_thumbnail_failed_${response.status}`)
  }
  return URL.createObjectURL(await response.blob())
}

export async function assignImmichPerson(treeId, personId, immichPersonId, token, { replaceAvatar = false } = {}) {
  return apiRequest(`/trees/${encodeURIComponent(treeId)}/immich/assign`, withAuth({
    method: 'POST',
    // replaceAvatar : accord explicite pour remplacer un portrait déjà en place — le serveur
    // refuse sinon (409 avatar_exists), quelle que soit l'origine du portrait actuel.
    body: JSON.stringify({ personId, immichPersonId, ...(replaceAvatar ? { replaceAvatar: true } : {}) }),
  }, token))
}

export async function unassignImmichPerson(treeId, personId, token) {
  return apiRequest(`/trees/${encodeURIComponent(treeId)}/immich/unassign`, withAuth({
    method: 'POST',
    body: JSON.stringify({ personId }),
  }, token))
}
