import { useEffect, useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { ArrowLeft, Check, ChevronLeft, ChevronRight, Image, Search, Sparkles, UserRound, Video, X, ZoomIn } from 'lucide-react'
import { fetchImmichAsset, fetchImmichThumbnail, getImmichErrorMessage, listImmichAssets, listImmichPeople } from '../api/immichApi.js'
import { t } from '../i18n/index.js'
import PzBusy from './PzBusy.jsx'
import './ImmichAssetPicker.css'

function AssetImage({ treeId, token, asset, large = false }) {
  const [url, setUrl] = useState('')
  const [failed, setFailed] = useState(false)
  const imageRef = useRef(null)
  useEffect(() => {
    const controller = new AbortController()
    let objectUrl, observer
    setUrl(''); setFailed(false)
    const load = () => {
      observer?.disconnect()
      fetchImmichAsset(treeId, asset.id, token, large ? 'preview' : 'thumbnail', controller.signal).then((blob) => {
        if (!controller.signal.aborted) { objectUrl = URL.createObjectURL(blob); setUrl(objectUrl) }
      }).catch(() => { if (!controller.signal.aborted) setFailed(true) })
    }
    if (large || typeof IntersectionObserver === 'undefined') load()
    else {
      observer = new IntersectionObserver((entries) => { if (entries.some((entry) => entry.isIntersecting)) load() }, { rootMargin: '100px' })
      observer.observe(imageRef.current)
    }
    return () => { controller.abort(); observer?.disconnect(); if (objectUrl) URL.revokeObjectURL(objectUrl) }
  }, [treeId, token, asset.id, large])
  return <span ref={imageRef} className={`iap-image${large ? ' iap-image--large' : ''}`}>
    {url && <img src={url} alt={large ? asset.name : ''} onError={() => setFailed(true)} hidden={failed} />}
    {(!url || failed) && <span className="iap-placeholder">{failed ? <><Image size={26} /><span>{t('Aperçu indisponible')}</span></> : <PzBusy busy busyLabel={t('Chargement…')} />}</span>}
  </span>
}

function Face({ treeId, token, person }) {
  const [url, setUrl] = useState('')
  useEffect(() => {
    let cancelled = false, objectUrl
    if (person.hasThumbnail) fetchImmichThumbnail(treeId, person.id, token).then((value) => {
      objectUrl = value
      if (cancelled) URL.revokeObjectURL(value)
      else setUrl(value)
    }).catch(() => {})
    return () => { cancelled = true; if (objectUrl) URL.revokeObjectURL(objectUrl) }
  }, [treeId, token, person.id, person.hasThumbnail])
  return <span className="iap-face" aria-hidden="true">{url ? <img src={url} alt="" /> : <UserRound size={18} />}</span>
}

export default function ImmichAssetPicker({ treeId, token, onSelect, onClose }) {
  const uid = useId()
  const [search, setSearch] = useState({ page: 1, type: 'IMAGE', query: '', personId: '' })
  const [draft, setDraft] = useState('')
  const [result, setResult] = useState(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [selected, setSelected] = useState([])
  const [preview, setPreview] = useState(null)
  const [error, setError] = useState('')
  const [people, setPeople] = useState(null)
  const [faceOpen, setFaceOpen] = useState(false)
  const [faceQuery, setFaceQuery] = useState('')
  const [faceError, setFaceError] = useState('')
  const download = useRef(null), dialog = useRef(null), searchInput = useRef(null)
  const previewTrigger = useRef(null)
  useEffect(() => {
    const previous = document.activeElement
    searchInput.current?.focus()
    return () => { download.current?.abort(); previous?.focus() }
  }, [])
  useEffect(() => {
    const controller = new AbortController()
    setLoading(true); setError(''); setResult(null)
    listImmichAssets(treeId, token, search.page, search.type, { ...search, signal: controller.signal }).then((data) => {
      if (!controller.signal.aborted) setResult(data)
    }).catch((err) => { if (!controller.signal.aborted) setError(getImmichErrorMessage(err, t)) }).finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => controller.abort()
  }, [treeId, token, search])
  useEffect(() => {
    let cancelled = false
    listImmichPeople(treeId, token).then((data) => { if (!cancelled) setPeople(data) }).catch((err) => {
      if (!cancelled) { setPeople([]); setFaceError(getImmichErrorMessage(err, t)) }
    })
    return () => { cancelled = true }
  }, [treeId, token])
  const changeSearch = (values) => setSearch((current) => ({ ...current, ...values, page: 1 }))
  const submitSearch = () => changeSearch({ query: draft.trim() })
  const selectedFace = people?.find((person) => person.id === search.personId)
  const filteredPeople = (people || []).filter((person) => !faceQuery.trim() || person.name.toLocaleLowerCase().includes(faceQuery.trim().toLocaleLowerCase()))
  const closePreview = () => { setPreview(null); requestAnimationFrame(() => dialog.current?.querySelector(`[data-asset-id="${previewTrigger.current}"]`)?.focus()) }
  const handleKey = (event) => {
    event.stopPropagation()
    if (event.key === 'Escape') { event.preventDefault(); if (!busy) { if (preview) closePreview(); else onClose() } }
    if (event.key === 'Tab') {
      const elements = [...dialog.current.querySelectorAll('button:not(:disabled), input:not(:disabled), [tabindex="0"]')].filter((element) => element.getClientRects().length)
      const first = elements[0], last = elements.at(-1)
      if (event.shiftKey && (document.activeElement === first || document.activeElement === dialog.current)) { event.preventDefault(); last?.focus() }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
    }
  }
  const select = async (asset) => {
    if (busy || selected.includes(asset.id)) return
    setBusy(true); setError('')
    const controller = new AbortController()
    download.current = controller
    try {
      const blob = await fetchImmichAsset(treeId, asset.id, token, 'original', controller.signal)
      if (controller.signal.aborted) return
      if (!(asset.type === 'IMAGE' ? blob.type.startsWith('image/') : blob.type.startsWith('video/'))) {
        const error = new Error('invalid_immich_media'); error.payload = { error: 'invalid_immich_media' }; throw error
      }
      onSelect(new File([blob], asset.name || asset.id, { type: blob.type }))
      if (!controller.signal.aborted) setSelected((ids) => [...ids, asset.id])
    } catch (err) { if (!controller.signal.aborted) setError(getImmichErrorMessage(err, t)) }
    finally { if (!controller.signal.aborted) setBusy(false) }
  }
  return createPortal(<div className="pz-overlay iap-overlay" onClick={(event) => event.stopPropagation()} onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) onClose() }} onKeyDown={handleKey}>
    <section ref={dialog} className="pz-modal iap" role="dialog" aria-modal="true" aria-labelledby={`${uid}-title`} tabIndex={-1}>
      <button type="button" className="pz-btn pz-btn--ghost pz-btn--icon pz-modal-close" onClick={onClose} aria-label={t('Fermer')} disabled={busy}><X size={18} /></button>
      <header className="pz-modal-head iap-head">
        <p className="pz-eyebrow"><Sparkles size={14} />{t('Depuis Immich')}</p>
        <h2 id={`${uid}-title`} className="pz-title">{preview ? t('Un souvenir à regarder de plus près') : t('Retrouver vos souvenirs')}</h2>
        <p className="pz-small">{t('Choisissez une image pour l’agrandir, puis ajoutez-la aux souvenirs.')}</p>
      </header>
      {preview ? <>
        <div className="iap-preview-toolbar"><button type="button" className="pz-btn pz-btn--ghost pz-btn--sm" onClick={closePreview} disabled={busy}><ArrowLeft size={16} />{t('Retour aux photos')}</button><span className="pz-tag">{preview.type === 'VIDEO' ? t('Vidéo') : t('Photo')}</span></div>
        <div className="iap-preview-stage"><AssetImage key={preview.id} treeId={treeId} token={token} asset={preview} large /></div>
        <div className="iap-preview-caption"><p>{preview.name}</p>{preview.type === 'VIDEO' && <span className="pz-small">{t('Aperçu de la vidéo')}</span>}</div>
      </> : <>
        <div className="iap-controls">
          <div className="iap-search" role="search" aria-label={t('Recherche dans Immich')}>
            <Search size={18} aria-hidden="true" /><input ref={searchInput} value={draft} maxLength={500} onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); submitSearch() } }} placeholder={t('Un repas au jardin, des vacances à la mer…')} aria-label={t('Décrire la photo recherchée')} disabled={busy} />
            <button type="button" className="pz-btn pz-btn--primary pz-btn--sm" onClick={submitSearch} disabled={busy}>{t('Rechercher')}</button>
          </div>
          <div className="iap-filters">
            <div className="pz-tabs iap-types" role="group" aria-label={t('Type')}>
              {[['IMAGE', t('Photos'), Image], ['VIDEO', t('Vidéos'), Video]].map(([value, label, Icon]) => <button key={value} type="button" className={`pz-tab${search.type === value ? ' is-active' : ''}`} aria-pressed={search.type === value} onClick={() => changeSearch({ type: value })} disabled={busy}><Icon size={15} />{label}</button>)}
            </div>
            <button type="button" className={`pz-btn pz-btn--sm ${search.personId ? 'pz-btn--soft' : 'pz-btn--secondary'}`} aria-expanded={faceOpen} onClick={() => setFaceOpen((value) => !value)} disabled={busy}><UserRound size={16} />{selectedFace?.name || t('Filtrer par visage')}</button>
            {(search.query || search.personId) && <button type="button" className="pz-btn pz-btn--ghost pz-btn--sm" onClick={() => { setDraft(''); changeSearch({ query: '', personId: '' }) }} disabled={busy}><X size={14} />{t('Effacer les filtres')}</button>}
          </div>
          {faceOpen && <div className="iap-faces">
            <label className="pz-field"><span>{t('Personne reconnue dans Immich')}</span><input value={faceQuery} onChange={(event) => setFaceQuery(event.target.value)} placeholder={t('Rechercher par nom')} disabled={busy} /></label>
            {people === null ? <p className="pz-small" role="status">{t('Chargement…')}</p> : <div className="iap-face-list">
              <button type="button" className={`iap-face-choice${!search.personId ? ' is-active' : ''}`} onClick={() => { changeSearch({ personId: '' }); setFaceOpen(false) }} disabled={busy}><span className="iap-face"><UserRound size={18} /></span>{t('Tous les visages')}</button>
              {filteredPeople.slice(0, 30).map((person) => <button type="button" key={person.id} className={`iap-face-choice${search.personId === person.id ? ' is-active' : ''}`} onClick={() => { changeSearch({ personId: person.id }); setFaceOpen(false) }} disabled={busy}><Face treeId={treeId} token={token} person={person} /><span>{person.name || t('Sans nom')}</span>{search.personId === person.id && <Check size={15} />}</button>)}
            </div>}
            {filteredPeople.length > 30 && <p className="pz-small">{t('Précisez un nom pour voir les autres visages.')}</p>}
            {people?.length === 0 && <p className="pz-small">{t('Aucune personne dans Immich.')}</p>}
            {people?.length > 0 && filteredPeople.length === 0 && <p className="pz-small">{t('Aucune personne trouvée.')}</p>}
            {faceError && <p className="pz-error" role="alert">{faceError}</p>}
          </div>}
          <p className="pz-hint">{t('La recherche par contexte utilise la recherche intelligente activée dans Immich.')}</p>
        </div>
        <div className="iap-results" aria-busy={loading}>
          {loading ? <div className="iap-empty" role="status"><PzBusy busy busyLabel={t('Chargement…')} /><p>{t('À la recherche de vos souvenirs…')}</p></div> : result?.assets.length ? <div className="iap-grid">{result.assets.map((asset) => <article key={asset.id} className={`iap-asset${selected.includes(asset.id) ? ' is-selected' : ''}`}>
            <button type="button" className="iap-open" data-asset-id={asset.id} aria-label={t('Agrandir {name}', { name: asset.name })} onClick={() => { previewTrigger.current = asset.id; setPreview(asset); requestAnimationFrame(() => dialog.current?.focus()) }} disabled={busy}>
              <AssetImage treeId={treeId} token={token} asset={asset} /><span className="iap-zoom"><ZoomIn size={17} /></span>{asset.type === 'VIDEO' && <span className="iap-video"><Video size={14} />{t('Vidéo')}</span>}
            </button>
            <div className="iap-asset-caption"><span title={asset.name}>{asset.name}</span><button type="button" className={`iap-select${selected.includes(asset.id) ? ' is-selected' : ''}`} onClick={() => select(asset)} aria-label={selected.includes(asset.id) ? t('Ajouté') : t('Sélectionner {name}', { name: asset.name })} disabled={busy || selected.includes(asset.id)}><Check size={16} /></button></div>
          </article>)}</div> : !error && <div className="iap-empty"><Search size={28} /><p>{t('Aucun média trouvé.')}</p><span className="pz-small">{t('Essayez une autre description ou un autre visage.')}</span></div>}
        </div>
        {!loading && result && <nav className="iap-pagination" aria-label={t('Pages des souvenirs Immich')}><button type="button" className="pz-btn pz-btn--ghost pz-btn--sm" disabled={busy || search.page === 1} onClick={() => setSearch((current) => ({ ...current, page: current.page - 1 }))}><ChevronLeft size={17} />{t('Précédent')}</button><span className="pz-small">{t('Page {page}', { page: search.page })}</span><button type="button" className="pz-btn pz-btn--ghost pz-btn--sm" disabled={busy || !result.hasNextPage} onClick={() => setSearch((current) => ({ ...current, page: current.page + 1 }))}>{t('Suivant')}<ChevronRight size={17} /></button></nav>}
      </>}
      {error && <div className="iap-error"><p className="pz-error" role="alert">{error}</p>{!preview && <button type="button" className="pz-btn pz-btn--ghost pz-btn--sm" disabled={busy || loading} onClick={() => setSearch((current) => ({ ...current }))}>{t('Réessayer')}</button>}</div>}
      <footer className="iap-footer"><p className="pz-small">{selected.length === 1 ? t('1 souvenir sélectionné') : selected.length > 1 ? t('{n} souvenirs sélectionnés', { n: selected.length }) : t('Photo : 5 Mo · Vidéo : 20 Mo')}<span>{t('Vos médias seront copiés dans Parenthèse.')}</span></p>
        {preview ? <button type="button" className="pz-btn pz-btn--primary" onClick={() => select(preview)} disabled={busy || selected.includes(preview.id)}><Check size={17} /><PzBusy busy={busy} busyLabel={t('Téléchargement…')}>{selected.includes(preview.id) ? t('Ajouté') : t('Choisir ce souvenir')}</PzBusy></button> : <button type="button" className="pz-btn pz-btn--primary" onClick={onClose} disabled={busy}><PzBusy busy={busy} busyLabel={t('Téléchargement…')}>{t('Terminer la sélection')}</PzBusy></button>}
      </footer>
    </section>
  </div>, document.body)
}
