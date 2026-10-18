import { useEffect, useRef, useState } from 'react'
import { fetchImmichAsset, getImmichErrorMessage, listImmichAssets } from '../api/immichApi.js'
import { t } from '../i18n/index.js'
import './ImmichAssetPicker.css'

function Thumbnail({ treeId, token, asset }) {
  const [url, setUrl] = useState('')
  useEffect(() => {
    const controller = new AbortController()
    let objectUrl
    fetchImmichAsset(treeId, asset.id, token, 'thumbnail', controller.signal).then((blob) => {
      if (!controller.signal.aborted) {
        objectUrl = URL.createObjectURL(blob)
        setUrl(objectUrl)
      }
    }).catch(() => {})
    return () => { controller.abort(); if (objectUrl) URL.revokeObjectURL(objectUrl) }
  }, [treeId, token, asset.id])
  return url ? <img src={url} alt="" style={{ width: 80, height: 60, objectFit: 'cover' }} /> : <span>{asset.type === 'VIDEO' ? t('Vidéo') : t('Photo')}</span>
}

// Les originaux sont téléchargés un par un lors de la sélection. Ils suivent ensuite
// exactement le même parcours que des fichiers locaux, sans garder de lien privé Immich.
export default function ImmichAssetPicker({ treeId, token, onSelect, onClose }) {
  const [page, setPage] = useState(1)
  const [type, setType] = useState('IMAGE')
  const [result, setResult] = useState(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [selected, setSelected] = useState([])
  const [error, setError] = useState('')
  const download = useRef(null)
  useEffect(() => () => download.current?.abort(), [])
  useEffect(() => {
    let cancelled = false
    listImmichAssets(treeId, token, page, type).then((data) => {
      if (!cancelled) setResult(data)
    }).catch((err) => { if (!cancelled) setError(getImmichErrorMessage(err, t)) }).finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [treeId, token, page, type])
  const navigate = (nextPage, nextType = type) => {
    setLoading(true); setError(''); setResult(null); setPage(nextPage); setType(nextType)
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
        const error = new Error('invalid_immich_media')
        error.payload = { error: 'invalid_immich_media' }
        throw error
      }
      onSelect(new File([blob], asset.name || asset.id, { type: blob.type }))
      setSelected((ids) => [...ids, asset.id])
    } catch (err) { if (!controller.signal.aborted) setError(getImmichErrorMessage(err, t)) }
    finally { if (!controller.signal.aborted) setBusy(false) }
  }
  return <fieldset className="ms-immich" disabled={busy}>
    <legend>{t('Depuis Immich')}</legend>
    <p className="pz-small">{t('Les médias sélectionnés seront copiés dans les souvenirs. Photo : 5 Mo maximum ; vidéo : 20 Mo maximum.')}</p>
    <label>{t('Type')} <select value={type} onChange={(e) => navigate(1, e.target.value)}><option value="IMAGE">{t('Photos')}</option><option value="VIDEO">{t('Vidéos')}</option></select></label>
    {loading ? <p role="status">{t('Chargement…')}</p> : <div className="ms-immich-grid">{result?.assets.map((asset) => <button type="button" key={asset.id} className="ms-immich-asset" disabled={selected.includes(asset.id)} onClick={() => select(asset)}>
      <Thumbnail treeId={treeId} token={token} asset={asset} /><span>{asset.name}</span>{selected.includes(asset.id) && <span>{t('Ajouté')}</span>}
    </button>)}</div>}
    {!loading && result?.assets.length === 0 && <p>{t('Aucun média trouvé.')}</p>}
    {busy && <p role="status">{t('Téléchargement…')}</p>}
    {error && <p role="alert" className="pz-error">{error}</p>}
    <div className="ms-file-actions">
      <button type="button" disabled={loading || page === 1} onClick={() => navigate(page - 1)}>{t('Précédent')}</button>
      <button type="button" disabled={loading || !result?.hasNextPage} onClick={() => navigate(page + 1)}>{t('Suivant')}</button>
      <button type="button" onClick={onClose}>{t('Terminer la sélection')}</button>
    </div>
  </fieldset>
}
