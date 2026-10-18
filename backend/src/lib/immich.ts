import { createHash } from 'node:crypto'

import type { PrismaClient } from '@prisma/client'

import { env } from '../config/env.js'
import { decryptImmichApiKey } from './immich-secret.js'

// Client Immich : la reconnaissance des visages lit les personnes et leurs vignettes.
// Contrat vérifié sur la spécification OpenAPI officielle d'Immich v3.1.0 :
//   GET /api/server/ping                 -> 200 {"res":"pong"}
//   GET /api/people?page=N&size=M        -> 200 { people: PersonResponseDto[], total, hasNextPage, hidden } (size <= 1000)
//   GET /api/people/{id}                 -> 200 PersonResponseDto | 404 (id : UUID v4)
//   GET /api/people/{id}/thumbnail      -> 200 image binaire | 404
// Authentification : en-tête x-api-key ; clé refusée -> 401.

// Instance injoignable : réseau coupé, délai dépassé, réponse illisible.
export class ImmichUnavailableError extends Error {
  constructor(message = 'Immich est injoignable') {
    super(message)
    this.name = 'ImmichUnavailableError'
  }
}

// Clé d'API refusée par Immich (401/403).
export class ImmichAuthError extends Error {
  constructor(message = 'Clé d’API Immich refusée') {
    super(message)
    this.name = 'ImmichAuthError'
  }
}

// Personne ou vignette inexistante côté Immich (404).
export class ImmichNotFoundError extends Error {
  constructor(message = 'Personne Immich introuvable') {
    super(message)
    this.name = 'ImmichNotFoundError'
  }
}

const IMMICH_PEOPLE_PAGE_SIZE = 1000
const IMMICH_TIMEOUT_MS = 10_000
// Délai global de la liste complète : chaque page a son propre délai, la liste entière aussi.
const IMMICH_LIST_DEADLINE_MS = 30_000

// Identifiants de personnes Immich : UUID v4 (spécification OpenAPI).
const IMMICH_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export function isImmichPersonId(value: string): boolean {
  return IMMICH_ID_RE.test(value)
}

export type ImmichPersonSummary = {
  id: string
  name: string
  hasThumbnail: boolean
}

type ImmichPeoplePage = {
  people?: unknown
  hasNextPage?: unknown
}

export class ImmichClient {
  private readonly apiUrl: string
  private readonly apiKey: string

  constructor(apiUrl: string, apiKey: string) {
    this.apiUrl = apiUrl.replace(/\/$/, '')
    this.apiKey = apiKey
  }

  // Le chemin de l'instance (ex. /immich) reste devant les chemins de l'API : on concatène,
  // on ne résout pas une URL relative (qui effacerait ce chemin).
  // Corps JSON lu hors de toute gestion d'erreur : un corps illisible est une instance
  // défaillante (503), pas une erreur serveur.
  private async readJson(response: Response): Promise<unknown> {
    try {
      return await response.json()
    } catch {
      throw new ImmichUnavailableError('Réponse Immich illisible')
    }
  }

  private buildUrl(path: string): string {
    return `${this.apiUrl}${path}`
  }

  private async fetch(path: string, body?: unknown): Promise<Response> {
    const url = this.buildUrl(path)
    let response: Response
    try {
      response = await fetch(url, {
        method: body === undefined ? 'GET' : 'POST',
        body: body === undefined ? undefined : JSON.stringify(body),
        headers: { 'x-api-key': this.apiKey, Accept: 'application/json', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
        signal: AbortSignal.timeout(IMMICH_TIMEOUT_MS),
        // Aucune redirection suivie : la clé ne doit jamais partir vers une autre adresse.
        redirect: 'error',
      })
    } catch (error) {
      // L'URL ne contient aucun secret ; la clé voyage dans l'en-tête, jamais dans les journaux.
      console.warn(`Immich injoignable : ${url} (${(error as Error).message})`)
      throw new ImmichUnavailableError()
    }

    if (response.ok) {
      return response
    }

    // Journal avec le statut et l'URL (sans secret), puis remontée d'une erreur distincte par cause.
    console.warn(`Immich a répondu ${response.status} sur ${url}`)
    if (response.status === 401 || response.status === 403) {
      throw new ImmichAuthError()
    }
    if (response.status === 404) {
      throw new ImmichNotFoundError()
    }
    throw new ImmichUnavailableError(`Immich a répondu ${response.status}`)
  }

  async ping(): Promise<boolean> {
    try {
      const response = await this.fetch('/api/server/ping')
      const payload = (await response.json()) as { res?: unknown }
      return payload?.res === 'pong'
    } catch {
      return false
    }
  }

  async listAssets(page: number, type: 'IMAGE' | 'VIDEO') {
    const response = await this.fetch('/api/search/metadata', { page, size: 30, type, isTrashed: false })
    const payload = await this.readJson(response) as { assets?: { items?: Array<{ id: string; type: string; originalFileName: string }>; nextPage?: string | null } }
    if (!Array.isArray(payload.assets?.items)) throw new ImmichUnavailableError('Liste de médias Immich illisible')
    return {
      assets: payload.assets.items.filter((asset) => isImmichPersonId(asset.id) && asset.type === type).map((asset) => ({
        id: asset.id, type: asset.type, name: asset.originalFileName,
      })),
      hasNextPage: Boolean(payload.assets.nextPage),
    }
  }

  async getAssetBytes(assetId: string, thumbnail: boolean, maxBytes: number): Promise<Buffer | null> {
    return this.readBytes(`/api/assets/${encodeURIComponent(assetId)}/${thumbnail ? 'thumbnail?size=thumbnail' : 'original'}`, maxBytes)
  }

  // Toutes les personnes (sans les masquées), en suivant la pagination d'Immich.
  async listPeople(): Promise<ImmichPersonSummary[]> {
    const people: ImmichPersonSummary[] = []
    let page = 1

    const deadline = Date.now() + IMMICH_LIST_DEADLINE_MS
    // Garde-fou : une instance qui répondrait toujours hasNextPage ne doit pas nous faire boucler.
    for (let guard = 0; guard < 1000; guard += 1, page += 1) {
      if (Date.now() > deadline) {
        throw new ImmichUnavailableError('Liste des personnes Immich trop longue')
      }
      const response = await this.fetch(`/api/people?page=${page}&size=${IMMICH_PEOPLE_PAGE_SIZE}`)
      const payload = (await this.readJson(response)) as ImmichPeoplePage

      if (!Array.isArray(payload.people)) {
        throw new ImmichUnavailableError('Réponse Immich inattendue sur /api/people')
      }

      for (const person of payload.people as Array<{ id?: unknown; name?: unknown; thumbnailPath?: unknown }>) {
        if (typeof person?.id !== 'string' || typeof person?.name !== 'string') {
          throw new ImmichUnavailableError('Réponse Immich inattendue sur /api/people')
        }
        people.push({ id: person.id, name: person.name, hasThumbnail: typeof person.thumbnailPath === 'string' && person.thumbnailPath.length > 0 })
      }

      if (payload.hasNextPage !== true || (payload.people as unknown[]).length === 0) {
        break
      }
    }

    return people
  }

  // Une personne précise : 200 avec ses données, 404 si elle n'existe pas. Le 404 de la
  // vignette ne prouve rien (personne absente ou simple vignette manquante), l'existence
  // se vérifie donc ici.
  async getPerson(personId: string): Promise<ImmichPersonSummary> {
    const response = await this.fetch(`/api/people/${encodeURIComponent(personId)}`)
    const person = (await this.readJson(response)) as { id?: unknown; name?: unknown; thumbnailPath?: unknown }
    if (typeof person?.id !== 'string' || typeof person?.name !== 'string') {
      throw new ImmichUnavailableError('Réponse Immich inattendue sur /api/people/{id}')
    }
    return {
      id: person.id,
      name: person.name,
      hasThumbnail: typeof person.thumbnailPath === 'string' && person.thumbnailPath.length > 0,
    }
  }

  // Vignette d'une personne, en octets bruts (JPEG côté Immich). Absente -> ImmichNotFoundError.
  // Lue en flux : au-delà de maxBytes, la lecture s'arrête et renvoie null sans charger le reste.
  async getPersonThumbnail(personId: string, maxBytes: number): Promise<Buffer | null> {
    return this.readBytes(`/api/people/${encodeURIComponent(personId)}/thumbnail`, maxBytes)
  }

  private async readBytes(path: string, maxBytes: number): Promise<Buffer | null> {
    const response = await this.fetch(path)
    const declared = Number(response.headers.get('content-length'))
    if (Number.isFinite(declared) && declared > maxBytes) {
      await response.body?.cancel().catch(() => {})
      return null
    }
    if (!response.body) {
      return Buffer.alloc(0)
    }

    const reader = response.body.getReader()
    const chunks: Buffer[] = []
    let total = 0
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        total += value.byteLength
        if (total > maxBytes) {
          await reader.cancel().catch(() => {})
          return null
        }
        chunks.push(Buffer.from(value))
      }
    } catch {
      throw new ImmichUnavailableError('Lecture de la vignette Immich interrompue')
    }
    return Buffer.concat(chunks, total)
  }
}

// Instance Immich normalisée pour comparaison : origine + chemin, sans slash final. Null si l'URL
// est mal formée ou d'un autre protocole que http(s).
export function normalizeImmichApiUrl(value: string): string | null {
  try {
    const url = new URL(value)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return null
    }
    // Ni identifiants, ni requête, ni fragment : une adresse d'instance n'en porte pas, et
    // « https://instance@autre-hote » ne doit jamais passer pour l'instance.
    if (url.username || url.password || url.search || url.hash) {
      return null
    }
    return `${url.origin}${url.pathname.replace(/\/+$/, '')}`
  } catch {
    return null
  }
}

export type ImmichInstance = {
  // Identifiant opaque, dérivé de l'adresse (stable même si l'opérateur réordonne la liste).
  id: string
  label: string
  apiUrl: string
}

let instancesCache: ImmichInstance[] | undefined

export function immichInstanceId(apiUrl: string): string {
  return createHash('sha256').update(apiUrl).digest('hex').slice(0, 16)
}

// Instances Immich autorisées par l'opérateur du serveur (IMMICH_ALLOWED_API_URLS). C'est la seule
// liste d'adresses possibles : les administrateurs d'un arbre y choisissent la leur, le serveur
// ne devient jamais un proxy vers un service interne choisi librement. Format d'une entrée :
// « Libellé=https://adresse » ou « https://adresse ». Sans libellé, le nom d'hôte sert de nom.
// Entrées invalides, doublons et libellés en conflit sont ignorés avec un avertissement.
export function getImmichInstances(): ImmichInstance[] {
  if (instancesCache !== undefined) {
    return instancesCache
  }

  const instances: ImmichInstance[] = []
  for (const entry of env.IMMICH_ALLOWED_API_URLS.split(',')) {
    const trimmed = entry.trim()
    if (!trimmed) {
      continue
    }
    const named = /^(.*?)\s*=\s*(https?:\/\/.+)$/i.exec(trimmed)
    const rawUrl = named ? named[2] : trimmed
    const apiUrl = normalizeImmichApiUrl(rawUrl)
    if (!apiUrl) {
      console.warn(`IMMICH_ALLOWED_API_URLS : entrée ignorée (URL http(s) invalide) : ${trimmed}`)
      continue
    }
    if (instances.some((instance) => instance.apiUrl === apiUrl)) {
      continue
    }
    const label = (named?.[1] ?? '').trim() || new URL(apiUrl).hostname
    if (instances.some((instance) => instance.label.toLowerCase() === label.toLowerCase())) {
      console.warn(`IMMICH_ALLOWED_API_URLS : entrée ignorée, le nom « ${label} » est déjà pris : donnez-lui un libellé (Libellé=https://…)`)
      continue
    }
    instances.push({ id: immichInstanceId(apiUrl), label, apiUrl })
  }
  instancesCache = instances
  return instances
}

export function getImmichInstanceByApiUrl(value: string): ImmichInstance | undefined {
  const normalized = normalizeImmichApiUrl(value)
  return normalized === null ? undefined : getImmichInstances().find((instance) => instance.apiUrl === normalized)
}

export function isImmichApiUrlAllowed(value: string): boolean {
  return getImmichInstanceByApiUrl(value) !== undefined
}

// Connexion Immich d'un arbre : résolue par arbre, côté serveur, à chaque requête. Pas de client
// global qui garderait les identifiants d'un arbre et pourrait servir un autre ; pas d'héritage
// de configuration du serveur. Une clé illisible (JWT_SECRET changé) vaut « non configuré », et
// une adresse retirée de la liste de l'opérateur aussi : la connexion existante cesse de marcher.
export async function getTreeImmichClient(prisma: PrismaClient, treeId: string): Promise<ImmichClient | null> {
  const config = await prisma.treeImmichConfig.findUnique({
    where: { treeId },
    select: { apiUrl: true, apiKeyEnc: true },
  })
  if (!config) {
    return null
  }

  const apiKey = decryptImmichApiKey(config.apiKeyEnc)
  if (!apiKey) {
    return null
  }

  if (!isImmichApiUrlAllowed(config.apiUrl)) {
    return null
  }

  // Le client reçoit l'adresse autorisée, normalisée : pas celle, brute, de la base.
  return new ImmichClient(getImmichInstanceByApiUrl(config.apiUrl)!.apiUrl, apiKey)
}
