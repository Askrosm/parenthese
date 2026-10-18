import { useEffect, useMemo, useState } from 'react'
import { readContributorName } from '../utils/contributorName'
import { ArrowDown, ArrowUp, FileText, Image, MapPin, Mic, Plus, Quote, Route, Trash2, Upload, Video, X } from 'lucide-react'
import { getAcceptForMediaType } from '../utils/mediaUpload'
import GeoMediaThumbnail from './GeoMediaThumbnail'
import './MediaManagerPanel.css'
import PzBusy from './PzBusy.jsx'
import { t } from '../i18n/index.js'
import ImmichAssetPicker from './ImmichAssetPicker.jsx'
import { fetchImmichConfig } from '../api/immichApi.js'

const MEDIA_TYPES = [
  { value: 'photo', label: t('Photo'), Icon: Image },
  { value: 'video', label: t('Vidéo'), Icon: Video },
  { value: 'audio', label: t('Voix'), Icon: Mic },
  { value: 'citation', label: t('Citation'), Icon: Quote },
  { value: 'document', label: t('Document'), Icon: FileText },
  { value: 'geojson', label: t('Carte'), Icon: MapPin },
  { value: 'gpx', label: t('Trace GPX'), Icon: Route },
]
// La famille garde l'essentiel ; carte et trace GPX restent au propriétaire
const FAMILY_TYPES = ['photo', 'video', 'audio', 'citation', 'document']
const TYPE_NAMES = { photo: t('Photo'), video: t('Vidéo'), audio: t('Voix'), citation: t('Citation'), document: t('Document'), geojson: t('Carte'), gpx: t('Trace GPX') }
const TYPE_SHORT = { video: t('Vidéo'), audio: t('Voix'), citation: '«', document: t('Doc') }

const YOUTUBE_RE = /^https:\/\/(www\.)?(youtube\.com|youtu\.be)\//
const HTTP_URL_RE = /^https?:\/\/\S+$/i

const MediaManagerPanel = ({
  visible,
  person,
  medias,
  loading,
  errorMessage,
  notice = '',
  canManage = true,
  treeId,
  token,
  onClose,
  onUpload,
  onMove,
  onDelete,
}) => {
  const [caption, setCaption] = useState('')
  const [source, setSource] = useState('')
  const [file, setFile] = useState(null)
  const [immichConfigured, setImmichConfigured] = useState(false)
  const [pickingImmich, setPickingImmich] = useState(false)
  useEffect(() => {
    let cancelled = false
    if (visible && canManage && treeId && token) fetchImmichConfig(treeId, token).then(({ config }) => {
      if (!cancelled) setImmichConfigured(Boolean(config?.configured))
    }).catch(() => { if (!cancelled) setImmichConfigured(false) })
    return () => { cancelled = true }
  }, [visible, canManage, treeId, token])
  useEffect(() => { if (!visible) { setPickingImmich(false); setImmichConfigured(false) } }, [visible])
  const [mediaType, setMediaType] = useState('photo')
  const [citationText, setCitationText] = useState('')
  const [videoMode, setVideoMode] = useState('file') // 'file' | 'youtube'
  const [youtubeUrl, setYoutubeUrl] = useState('')
  const [contributorName, setContributorName] = useState(() => readContributorName())
  // Le panneau est monté dès le départ : relire le prénom à chaque ouverture (il a pu être donné entre-temps)
  useEffect(() => {
    if (visible) setContributorName((current) => current || readContributorName())
  }, [visible])

  const isCitation = mediaType === 'citation'
  const isYoutubeVideo = mediaType === 'video' && videoMode === 'youtube'
  const canUpload = useMemo(() => {
    if (loading || pickingImmich) {
      return false
    }

    if (!canManage && !contributorName.trim()) {
      return false
    }

    if (isCitation) {
      return citationText.trim().length > 0
    }

    if (isYoutubeVideo) {
      return YOUTUBE_RE.test(youtubeUrl.trim())
    }

    return Boolean(file)
  }, [canManage, citationText, contributorName, file, isCitation, isYoutubeVideo, loading, pickingImmich, youtubeUrl])
  const fileAccept = useMemo(() => getAcceptForMediaType(mediaType), [mediaType])

  if (!visible || !person) {
    return null
  }

  const handleSubmit = async (event) => {
    event.preventDefault()
    if (!canUpload) {
      return
    }

    await onUpload({
      file,
      caption: caption.trim() || null,
      source: source.trim() || null,
      mediaType,
      citationText: citationText.trim(),
      youtubeUrl: isYoutubeVideo ? youtubeUrl.trim() : null,
      submittedByLabel: canManage ? null : contributorName.trim(),
    })
    setFile(null)
    setCaption('')
    setSource('')
    setMediaType('photo')
    setCitationText('')
    setVideoMode('file')
    setYoutubeUrl('')
  }

  const handleOverlayClick = (event) => {
    if (event.target === event.currentTarget) {
      onClose()
    }
  }

  const renderSource = (value) => {
    const normalized = String(value || '').trim()
    if (!normalized) {
      return null
    }

    if (HTTP_URL_RE.test(normalized)) {
      return (
        <a href={normalized} target="_blank" rel="noreferrer">
          {normalized}
        </a>
      )
    }

    return normalized
  }

  const changeType = (value) => {
    setMediaType(value)
    setFile(null)
    setCitationText('')
    setVideoMode('file')
    setYoutubeUrl('')
  }

  return (
    <div className="pz-overlay media-manager-modal-overlay" onClick={handleOverlayClick}>
      <div className="pz-modal pz-modal--wide media-manager-modal-card" role="dialog" aria-modal="true" aria-labelledby="mediaManagerTitle">
        <div className="pz-modal-head">
          <p className="pz-eyebrow">{canManage ? t('Souvenirs') : t('Ajouter un souvenir pour')}</p>
          <h1 id="mediaManagerTitle" className="pz-title">{person.firstName} <em>{person.lastName}</em></h1>
        </div>
        <button type="button" className="pz-btn pz-btn--ghost pz-btn--icon pz-modal-close" onClick={onClose} aria-label={t('Fermer')}>
          <X size={18} aria-hidden="true" />
        </button>

        <form className="mm-form" onSubmit={handleSubmit}>
          <div className="pz-field">
            <span className="pz-label" id="mediaUploadTypeLabel">{canManage ? t('Ajouter') : t('Que voulez-vous ajouter ?')}</span>
            <div className="mm-types" role="radiogroup" aria-labelledby="mediaUploadTypeLabel">
              {MEDIA_TYPES.filter((type) => canManage || FAMILY_TYPES.includes(type.value)).map((type) => (
                <button
                  key={type.value}
                  type="button"
                  role="radio"
                  aria-checked={mediaType === type.value}
                  className={`mm-type ${mediaType === type.value ? 'is-active' : ''}`}
                  onClick={() => changeType(type.value)}
                >
                  <type.Icon size={18} strokeWidth={1.8} aria-hidden="true" />
                  <span>{type.label}</span>
                </button>
              ))}
            </div>
          </div>

          {mediaType === 'video' && (
            <div className="pz-tabs mm-video-mode" role="radiogroup" aria-label={t('Source de la vidéo')}>
              <button type="button" role="radio" aria-checked={videoMode === 'file'} className={`pz-tab ${videoMode === 'file' ? 'is-active' : ''}`} onClick={() => { setVideoMode('file'); setYoutubeUrl('') }}>
                {t('Un fichier')}
              </button>
              <button type="button" role="radio" aria-checked={videoMode === 'youtube'} className={`pz-tab ${videoMode === 'youtube' ? 'is-active' : ''}`} onClick={() => { setVideoMode('youtube'); setFile(null) }}>
                {t('Un lien YouTube')}
              </button>
            </div>
          )}

          {canManage && immichConfigured && <button type="button" className="pz-btn pz-btn--soft" disabled={loading} onClick={() => setPickingImmich((value) => !value)}>{t('Depuis Immich')}</button>}
          {pickingImmich && canManage && <ImmichAssetPicker treeId={treeId} token={token} onClose={() => setPickingImmich(false)} onSelect={(selectedFile) => {
            setFile(selectedFile); setMediaType(selectedFile.type.startsWith('video/') ? 'video' : 'photo'); setVideoMode('file'); setPickingImmich(false)
          }} />}
          {!isCitation && !isYoutubeVideo && (
            <div className="pz-field">
              <label htmlFor="mediaUploadFile" className="mm-drop">
                <span className="mm-drop-icon" aria-hidden="true"><Upload size={20} strokeWidth={1.8} /></span>
                <span className="mm-drop-text">
                  <strong>{file ? file.name : t('Choisir un fichier')}</strong>
                  <span>{file ? t('Pour en prendre un autre, touchez ici') : mediaType === 'photo' ? t('5 Mo au maximum') : t('20 Mo au maximum')}</span>
                </span>
              </label>
              <input
                id="mediaUploadFile"
                className="mm-drop-input"
                type="file"
                accept={fileAccept}
                onChange={(event) => setFile(event.target.files?.[0] || null)}
              />
            </div>
          )}

          {isYoutubeVideo && (
            <div className="pz-field">
              <label htmlFor="mediaUploadYoutube">{t('Lien de la vidéo')}</label>
              <input
                id="mediaUploadYoutube"
                type="url"
                value={youtubeUrl}
                onChange={(event) => setYoutubeUrl(event.target.value)}
                placeholder="https://www.youtube.com/watch?v=…"
              />
            </div>
          )}

          {isCitation && (
            <div className="pz-field">
              <label htmlFor="mediaUploadCitation">{t("Ce qu'elle ou il disait")}</label>
              <textarea
                id="mediaUploadCitation"
                value={citationText}
                onChange={(event) => setCitationText(event.target.value)}
                placeholder={t('On partait à six dans la 4L, le coffre attaché avec une ficelle.')}
                rows={3}
              />
            </div>
          )}

          <div className={canManage ? 'pz-row2' : undefined}>
            <div className="pz-field">
              <label htmlFor="mediaUploadCaption">{canManage ? t('Titre') : t('Une légende')} <span className="mm-optional">{t('facultatif')}</span></label>
              <input
                id="mediaUploadCaption"
                type="text"
                value={caption}
                onChange={(event) => setCaption(event.target.value)}
                placeholder={t('Été à Quiberon, 1978')}
              />
            </div>
            {canManage && <div className="pz-field">
              <label htmlFor="mediaUploadSource">{t('Source')} <span className="mm-optional">{t('facultatif')}</span></label>
              <input
                id="mediaUploadSource"
                type="text"
                value={source}
                onChange={(event) => setSource(event.target.value)}
                placeholder={t('Album de famille, ou un lien')}
              />
            </div>}
          </div>

          {!canManage && (
            <div className="pz-field">
              <label htmlFor="mm-contributor-name">{t('Votre prénom')}</label>
              <input
                id="mm-contributor-name"
                type="text"
                value={contributorName}
                onChange={(e) => setContributorName(e.target.value.slice(0, 120))}
                placeholder={t("Pour que la famille sache qui l'a ajouté")}
                autoComplete="given-name"
              />
            </div>
          )}

          {errorMessage && <div className="pz-error" role="alert">{errorMessage}</div>}
          {notice && !errorMessage && <div className="pz-success" role="status">{notice}</div>}

          <div className="pz-modal-actions">
            <button type="submit" className="pz-btn pz-btn--primary" disabled={!canUpload}>
              <Plus size={16} aria-hidden="true" />
              <PzBusy busy={loading} busyLabel={t('Envoi du souvenir')}>{t('Ajouter ce souvenir')}</PzBusy>
            </button>
          </div>
        </form>

        <section className="mm-list-wrap">
          <h2 className="pz-eyebrow">{medias.length > 0 ? t('Déjà là · {n}', { n: medias.length }) : t('Déjà là')}</h2>
          {medias.length === 0 ? (
            <p className="pz-small mm-empty">{canManage ? t('Pas encore de souvenir. Le premier que vous ajoutez apparaît en tête de sa fiche.') : t('Pas encore de souvenir. Le vôtre sera le premier.')}</p>
          ) : (
            <ul className="mm-list">
              {medias.map((media, index) => (
                <li key={media.id} className="mm-item">
                  <span className="mm-preview" aria-hidden="true">
                    {media.type === 'photo' && media.url ? (
                      <img src={media.url} alt="" />
                    ) : media.type === 'geojson' || media.type === 'gpx' ? (
                      <GeoMediaThumbnail media={media} className="media-manager-modal-preview-map" />
                    ) : (
                      <span>{TYPE_SHORT[media.type] || media.type}</span>
                    )}
                  </span>
                  <span className="mm-meta">
                    <strong>{media.label || t('Souvenir {n}', { n: index + 1 })}</strong>
                    <span>
                      {TYPE_NAMES[media.type] || media.type}
                      {media.source && <> · {renderSource(media.source)}</>}
                    </span>
                  </span>
                  {canManage && <span className="mm-actions">
                    <button type="button" className="pz-btn pz-btn--ghost pz-btn--icon" onClick={() => onMove(media.id, -1)} disabled={loading || index === 0} aria-label={t('Monter')}>
                      <ArrowUp size={16} aria-hidden="true" />
                    </button>
                    <button type="button" className="pz-btn pz-btn--ghost pz-btn--icon" onClick={() => onMove(media.id, 1)} disabled={loading || index === medias.length - 1} aria-label={t('Descendre')}>
                      <ArrowDown size={16} aria-hidden="true" />
                    </button>
                    <button type="button" className="pz-btn pz-btn--danger-ghost pz-btn--icon" onClick={() => onDelete(media.id)} disabled={loading} aria-label={t('Supprimer')}>
                      <Trash2 size={16} aria-hidden="true" />
                    </button>
                  </span>}
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  )
}

export default MediaManagerPanel
