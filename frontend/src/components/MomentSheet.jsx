import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { X, Paperclip, Images, FileText, Mic, Play, Check } from 'lucide-react'
import { t } from '../i18n/index.js'
import { createLifeEvent, updateLifeEvent, deleteLifeEvent } from '../api/treeApi.js'
import { DESCRIBED_TYPES, eventTitle } from '../utils/lifeTimeline.js'
import { inferMediaTypeFromMimeType } from '../utils/mediaUpload.js'
import { readContributorName, saveContributorName } from '../utils/contributorName.js'
import './MomentSheet.css'
import ImmichAssetPicker from './ImmichAssetPicker.jsx'
import { fetchImmichConfig } from '../api/immichApi.js'

// Fiche « Ajouter un moment » de l'onglet Vie : quoi, quand, où, et des souvenirs (photo, vidéo, acte en
// PDF, enregistrement). La date exacte, la fin, la source et la note restent dans « Plus de détails ».
// Trois usages : ajouter (administrateur ou famille), modifier un moment (administrateur), et compléter une
// naissance, un mariage ou un décès avec ses documents (administrateur, la date se change dans Infos).

// Suggestions touchables : le texte exact devient le type correspondant (exporté en GEDCOM sous sa balise)
const SUGGESTIONS = [
  { label: t('Baptême'), type: 'baptism' },
  { label: t('Déménagement'), type: 'residence' },
  { label: t('Diplôme'), type: 'graduation' },
  { label: t('Service militaire'), type: 'military' },
  { label: t('Retraite'), type: 'retirement' },
]
const ACCEPTED_FILES = 'image/*,video/*,audio/*,application/pdf'
const FILE_ICONS = { video: Play, audio: Mic, document: FileText }

const yearOf = (value) => String(value ?? '').match(/^(\d{4})/)?.[1] || ''
const exactDay = (value) => (/^\d{4}-\d{2}-\d{2}$/.test(String(value ?? '')) && !String(value).endsWith('-01-01') ? value : '')

function FileThumb({ type, url }) {
  if (type === 'photo' && url) return <img src={url} alt="" />
  const Icon = FILE_ICONS[type] || Paperclip
  return <span className="ms-file-icon"><Icon size={18} strokeWidth={1.8} /></span>
}

export default function MomentSheet({ person, entry = null, treeId, token, medias = [], isAdmin = false, onUploadFile, onClose, onSaved }) {
  const milestone = entry?.milestone || null
  const event = entry?.event || null
  const editing = Boolean(event)
  const [what, setWhat] = useState(() => (event && !milestone ? eventTitle(event) : ''))
  const [year, setYear] = useState(() => yearOf(event?.date))
  const [approx, setApprox] = useState(() => ['about', 'estimated', 'calculated', 'between'].includes(event?.datePrecision))
  const [place, setPlace] = useState(event?.place || '')
  const [day, setDay] = useState(() => exactDay(event?.date))
  const [endYear, setEndYear] = useState(() => yearOf(event?.dateEnd))
  const [sources, setSources] = useState(event?.sources || '')
  const [notes, setNotes] = useState(event?.notes || '')
  const [linkedIds, setLinkedIds] = useState(() => (entry?.mediaIds || []).map(String))
  const [files, setFiles] = useState([])
  const [picking, setPicking] = useState(false)
  const [immichConfigured, setImmichConfigured] = useState(false)
  const [pickingImmich, setPickingImmich] = useState(false)
  useEffect(() => {
    let cancelled = false
    if (isAdmin) fetchImmichConfig(treeId, token).then(({ config }) => {
      if (!cancelled) setImmichConfigured(Boolean(config?.configured))
    }).catch(() => {})
    return () => { cancelled = true }
  }, [isAdmin, treeId, token])
  const [name, setName] = useState(() => readContributorName() || '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [confirmDelete, setConfirmDelete] = useState(false)
  const firstFieldRef = useRef(null)
  const created = useRef(null)
  const fileRef = useRef(null)
  const hasDetails = Boolean(day || endYear || sources || notes)

  useEffect(() => { firstFieldRef.current?.focus() }, [])
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape' && !busy) onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [busy, onClose])
  // Aperçus des fichiers choisis : libérés quand on en retire un, et tous à la fermeture
  const filesRef = useRef(files)
  useEffect(() => { filesRef.current = files }, [files])
  useEffect(() => () => filesRef.current.forEach((f) => f.preview && URL.revokeObjectURL(f.preview)), [])
  const removeFile = (key) => setFiles((list) => {
    list.filter((f) => f.key === key && f.preview).forEach((f) => URL.revokeObjectURL(f.preview))
    return list.filter((f) => f.key !== key)
  })

  const mediaById = new Map(medias.map((m) => [String(m.id), m]))
  const linked = linkedIds.map((id) => mediaById.get(id)).filter(Boolean)
  // Souvenirs qu'on peut rattacher : ceux de la fiche, sauf les citations (du texte, pas un document)
  const pickable = medias.filter((m) => m.type !== 'citation')
  const yearValid = !year || /^\d{4}$/.test(year)
  const endValid = !endYear || (/^\d{4}$/.test(endYear) && (!year || Number(endYear) >= Number(year)))
  const canSave = (milestone || what.trim().length > 0) && yearValid && endValid && !busy && !pickingImmich

  const addFiles = (list) => {
    const next = [...list].map((file) => {
      const type = inferMediaTypeFromMimeType(file.type)
      return { key: `${file.name}-${file.size}-${file.lastModified}`, file, type, preview: type === 'photo' ? URL.createObjectURL(file) : '' }
    })
    setFiles((current) => {
      const merged = [...current]
      for (const item of next) {
        if (merged.some((existing) => existing.key === item.key)) {
          if (item.preview) URL.revokeObjectURL(item.preview)
        } else merged.push(item)
      }
      return merged
    })
  }
  const toggleLinked = (id) => setLinkedIds((ids) => (ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id]))

  const buildPayload = () => {
    if (milestone) {
      return {
        ...(editing ? {} : { type: milestone.type, ...(milestone.unionId ? { unionId: milestone.unionId } : {}) }),
        sources: sources.trim() || null,
        notes: notes.trim() || null,
        mediaIds: linkedIds,
      }
    }
    const text = what.trim()
    const suggestion = SUGGESTIONS.find((s) => s.label.toLowerCase() === text.toLowerCase())
    const type = editing ? event.type : (suggestion?.type || 'custom')
    const textField = DESCRIBED_TYPES.includes(type) ? 'description' : 'label'
    // Une suggestion reprise telle quelle n'a pas besoin de libellé : le type suffit
    const textValue = !editing && suggestion ? null : text
    const start = day || year || null
    let datePrecision = null
    if (start && endYear) datePrecision = approx ? 'between' : 'from'
    else if (start && approx && !day) datePrecision = 'about'
    return {
      ...(editing ? {} : { type }),
      [textField]: textValue,
      ...(textField === 'description' ? { label: null } : {}),
      date: start,
      dateEnd: start && endYear ? endYear : null,
      datePrecision,
      place: place.trim() || null,
      sources: sources.trim() || null,
      notes: notes.trim() || null,
      mediaIds: linkedIds,
      ...(!isAdmin && name.trim() ? { submittedByLabel: name.trim() } : {}),
    }
  }

  const save = async () => {
    if (!canSave) return
    setBusy(true)
    setError('')
    try {
      // Un fichier refusé au milieu de l'envoi : le moment est déjà créé, on ne le recrée pas en réessayant
      let eventId = event?.id || created.current?.id || null
      let status = created.current?.status || 'approved'
      if (editing) {
        await updateLifeEvent(treeId, eventId, buildPayload(), token)
      } else if (!created.current) {
        const response = await createLifeEvent(treeId, person.id, buildPayload(), token)
        eventId = response?.event?.id
        status = response?.event?.status || 'approved'
        created.current = { id: eventId, status }
      }
      if (!isAdmin && name.trim()) saveContributorName(name.trim())
      // Les nouveaux fichiers deviennent des souvenirs rattachés au moment, un par un ; chaque fichier envoyé
      // sort de la liste, pour qu'un nouvel essai n'envoie que ceux qui restent
      // Légende : le moment pour une photo, le nom du fichier pour un acte ou une vidéo (« acte-naissance »)
      const momentTitle = milestone ? entry.title : what.trim()
      const uploaded = files.length > 0
      for (const item of files) {
        const caption = item.type === 'photo' ? momentTitle : (item.file.name.replace(/\.[a-z0-9]{1,5}$/i, '') || momentTitle).slice(0, 280)
        await onUploadFile(person.id, item.file, { lifeEventId: eventId, caption, submittedByLabel: !isAdmin ? name.trim() || null : null })
        removeFile(item.key)
      }
      onSaved({ pending: status === 'pending', uploaded })
    } catch (err) {
      setError(err?.message && !/^request_failed|^invalid_|^event_/.test(err.message) ? err.message : t('L’enregistrement n’a pas abouti. Réessayez dans un instant.'))
      setBusy(false)
    }
  }

  const remove = async () => {
    setBusy(true)
    setError('')
    try {
      await deleteLifeEvent(treeId, event.id, token)
      onSaved({ pending: false, uploaded: false })
    } catch {
      setError(t('La suppression n’a pas abouti. Réessayez dans un instant.'))
      setBusy(false)
    }
  }

  const title = milestone ? entry.title : editing ? t('Modifier ce moment') : t('Ajouter à la vie de {name}', { name: person.firstName })

  return createPortal(
    <div className="pz-overlay ms-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget && !busy) onClose() }}>
      <div className="pz-modal ms" role="dialog" aria-modal="true" aria-labelledby="ms-title">
        <button type="button" className="pz-btn pz-btn--ghost pz-btn--icon pz-modal-close" onClick={onClose} aria-label={t('Fermer')} disabled={busy}>
          <X size={18} strokeWidth={1.8} />
        </button>
        <div className="pz-modal-head">
          <h2 id="ms-title" className="pz-title ms-title">{title}</h2>
          {milestone && <p className="pz-small">{t('Ajoutez ses documents, un acte en PDF ou une photo, et la source. La date et le lieu se changent dans l’onglet Infos.')}</p>}
          {!isAdmin && <p className="pz-small">{t('Ce que vous ajoutez apparaîtra dans sa vie quand la personne qui gère l’arbre l’aura accepté.')}</p>}
        </div>

        <form className="ms-form" onSubmit={(e) => { e.preventDefault(); save() }}>
          {!milestone && (
            <>
              <div className="pz-field">
                <label htmlFor="ms-what">{t('Quoi ?')}</label>
                <input id="ms-what" ref={firstFieldRef} value={what} maxLength={120} onChange={(e) => setWhat(e.target.value)} placeholder={t('Service militaire, premier emploi, départ pour Paris…')} />
                {!editing && (
                  <div className="ms-chips">
                    {SUGGESTIONS.map((s) => (
                      <button key={s.type} type="button" className={`ms-chip${what === s.label ? ' is-on' : ''}`} onClick={() => setWhat(s.label)}>{s.label}</button>
                    ))}
                  </div>
                )}
              </div>

              <div className="ms-row">
                <div className="pz-field ms-year">
                  <label htmlFor="ms-year">{t('Quand ?')}</label>
                  <input id="ms-year" inputMode="numeric" maxLength={4} value={year} onChange={(e) => setYear(e.target.value.replace(/\D/g, ''))} placeholder={t('Année')} aria-invalid={!yearValid || undefined} disabled={Boolean(day)} />
                </div>
                <label className="ms-check">
                  <input type="checkbox" checked={approx} onChange={(e) => setApprox(e.target.checked)} disabled={Boolean(day) && !endYear} />
                  {t('environ')}
                </label>
              </div>

              <div className="pz-field">
                <label htmlFor="ms-place">{t('Où ?')} <span className="ms-optional">{t('facultatif')}</span></label>
                <input id="ms-place" value={place} maxLength={300} onChange={(e) => setPlace(e.target.value)} placeholder={t('Ville ou adresse')} />
              </div>
            </>
          )}

          <div className="pz-field">
            <span className="pz-label">{t('Souvenirs')} <span className="ms-optional">{t('facultatif')}</span></span>
            <p className="pz-small ms-hint">{t('Une photo, une vidéo, un enregistrement ou un document, comme un acte en PDF. Ils rejoignent aussi ses souvenirs.')}</p>
            {(linked.length > 0 || files.length > 0) && (
              <ul className="ms-files">
                {linked.map((media) => (
                  <li key={media.id} className="ms-file">
                    <FileThumb type={media.type} url={media.url} />
                    <span className="ms-file-name">{media.label}</span>
                    <button type="button" className="pz-btn pz-btn--ghost pz-btn--sm" onClick={() => toggleLinked(String(media.id))} disabled={busy}>{t('Retirer')}</button>
                  </li>
                ))}
                {files.map((item) => (
                  <li key={item.key} className="ms-file">
                    <FileThumb type={item.type} url={item.preview} />
                    <span className="ms-file-name">{item.file.name}</span>
                    <button type="button" className="pz-btn pz-btn--ghost pz-btn--sm" onClick={() => removeFile(item.key)} disabled={busy}>{t('Retirer')}</button>
                  </li>
                ))}
              </ul>
            )}
            <div className="ms-file-actions">
              {isAdmin && immichConfigured && <button type="button" className="ms-file-add" disabled={busy} onClick={() => setPickingImmich((value) => !value)}>{t('Depuis Immich')}</button>}
              <button type="button" ref={milestone ? firstFieldRef : undefined} className="ms-file-add" onClick={() => fileRef.current?.click()} disabled={busy || !onUploadFile}>
                <Paperclip size={15} strokeWidth={1.8} />
                {t('Ajouter un fichier')}
              </button>
              {pickable.length > 0 && (
                <button type="button" className="ms-file-add" aria-expanded={picking} onClick={() => setPicking((v) => !v)} disabled={busy}>
                  <Images size={15} strokeWidth={1.8} />
                  {t('Choisir parmi ses souvenirs')}
                </button>
              )}
            </div>
            {pickingImmich && <ImmichAssetPicker treeId={treeId} token={token} onSelect={(file) => addFiles([file])} onClose={() => setPickingImmich(false)} />}
            <input ref={fileRef} type="file" accept={ACCEPTED_FILES} multiple hidden onChange={(e) => { addFiles(e.target.files || []); e.target.value = '' }} />
            {picking && (
              <div className="ms-pick" role="group" aria-label={t('Souvenirs de {name}', { name: person.firstName })}>
                {pickable.map((media) => {
                  const on = linkedIds.includes(String(media.id))
                  return (
                    <button key={media.id} type="button" className={`ms-pick-item${on ? ' is-on' : ''}`} aria-pressed={on} onClick={() => toggleLinked(String(media.id))} title={media.label}>
                      <FileThumb type={media.type} url={media.url} />
                      {on && <span className="ms-pick-check"><Check size={12} strokeWidth={3} /></span>}
                    </button>
                  )
                })}
              </div>
            )}
          </div>

          {!isAdmin && (
            <div className="pz-field">
              <label htmlFor="ms-name">{t('Votre prénom')} <span className="ms-optional">{t('facultatif')}</span></label>
              <input id="ms-name" value={name} maxLength={120} onChange={(e) => setName(e.target.value)} placeholder={t('Pour que la famille sache de qui ça vient')} />
            </div>
          )}

          <details className="ms-more" open={hasDetails || milestone ? true : undefined}>
            <summary>{milestone ? t('Source et note') : t('Plus de détails')}</summary>
            <div className="ms-more-body">
              {!milestone && (
                <div className="ms-row">
                  <div className="pz-field">
                    <label htmlFor="ms-day">{t('Date exacte')}</label>
                    <input id="ms-day" type="date" value={day} onChange={(e) => { setDay(e.target.value); if (e.target.value) setYear(e.target.value.slice(0, 4)) }} />
                  </div>
                  <div className="pz-field ms-year">
                    <label htmlFor="ms-end">{t('Jusqu’en')}</label>
                    <input id="ms-end" inputMode="numeric" maxLength={4} value={endYear} onChange={(e) => setEndYear(e.target.value.replace(/\D/g, ''))} placeholder={t('Année')} aria-invalid={!endValid || undefined} />
                  </div>
                </div>
              )}
              <div className="pz-field">
                <label htmlFor="ms-sources">{t('Source')}</label>
                <textarea id="ms-sources" rows={2} value={sources} maxLength={4000} onChange={(e) => setSources(e.target.value)} placeholder={t('Registre, acte, archive, témoignage… une par ligne')} />
              </div>
              <div className="pz-field">
                <label htmlFor="ms-notes">{t('Note')}</label>
                <textarea id="ms-notes" rows={2} value={notes} maxLength={4000} onChange={(e) => setNotes(e.target.value)} />
              </div>
            </div>
          </details>

          {error && <p className="pz-error" role="alert">{error}</p>}

          <div className={`pz-modal-actions${editing && !milestone ? ' pz-modal-actions--split' : ''}`}>
            {editing && !milestone && (confirmDelete ? (
              <span className="ms-confirm">
                <button type="button" className="pz-btn pz-btn--danger" onClick={remove} disabled={busy}>{t('Supprimer')}</button>
                <button type="button" className="pz-btn pz-btn--ghost" onClick={() => setConfirmDelete(false)} disabled={busy}>{t('Garder')}</button>
              </span>
            ) : (
              <button type="button" className="pz-btn pz-btn--ghost ms-delete" onClick={() => setConfirmDelete(true)} disabled={busy}>{t('Supprimer ce moment')}</button>
            ))}
            <span className="ms-actions-end">
              <button type="button" className="pz-btn pz-btn--ghost" onClick={onClose} disabled={busy}>{t('Annuler')}</button>
              <button type="submit" className="pz-btn pz-btn--primary" disabled={!canSave}>
                {busy ? t('Enregistrement…') : editing || milestone ? t('Enregistrer') : isAdmin ? t('Ajouter') : t('Envoyer')}
              </button>
            </span>
          </div>
        </form>
      </div>
    </div>,
    document.body,
  )
}
