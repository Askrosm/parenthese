import { useEffect, useState, useCallback, useRef, useMemo } from 'react'
import { buildMediaUrl } from './utils/mediaToken.js'
import Galaxy from './components/Galaxy'
import PersonCard from './components/PersonCard.jsx'
import { FamilyWelcome, SouvenirPicker } from './components/FamilyOnboarding.jsx'
import { HELP_URL } from './utils/siteLinks.js'
import { hasSeenFamilyWelcome, markFamilyWelcomeSeen } from './utils/familyWelcome'
import MediaViewer from './components/MediaViewer'
import MediaManagerPanel from './components/MediaManagerPanel'
import AdminPanel from './components/AdminPanel'
import AccessGate from './components/AccessGate'
import AccountDashboard from './components/AccountDashboard'
import AccountPanel from './components/AccountPanel'
import TreeCreationWizard from './components/TreeCreationWizard'
import PhotoStartPanel from './components/PhotoStartPanel.jsx'
import ContributionPanel from './components/ContributionPanel'
import EditModeOverlay from './components/EditSessionBar.jsx'
import EditConfirmModal from './components/EditConfirmModal'
import DraftRestoreBanner from './components/DraftRestoreBanner'
import AddPersonPanel from './components/AddPersonPanel'
import ContributionSessionModal from './components/ContributionSessionModal'
import { ContextualNavbar } from './components/navbar'
import ZoomControl from './components/ZoomControl'
import { ExpandableSearch } from './components/search'
import { t, dateLocale } from './i18n/index.js'
import {
  createParentChildLink,
  deleteParentChildLink,
  deletePerson,
  deleteUnion,
  createPerson,
  createTree,
  createUnion,
  batchAnnotations,
  deletePersonAvatar,
  getTree,
  importGedcom,
  linkTreeAccess,
  updateTree,
  rotateTreePasswords,
  fetchSharePassword,
  rememberSharePassword,
  resolveTreeBySlug,
  uploadPersonAvatar,
  updatePerson,
  uploadAnnotationPhoto,
  reorderSiblings,
  uploadPersonMedia,
} from './api/treeApi'
import { getImmichErrorMessage, unassignImmichPerson } from './api/immichApi.js'
import { useAuth } from './hooks/useAuth'
import { useTreeAccess, getTreeTokenStorageKey, getSlugFromPathname, readTreeAccessRole, TREE_ID_FROM_ENV } from './hooks/useTreeAccess'
import { useMediaManager } from './hooks/useMediaManager'
import { useContributions } from './hooks/useContributions'
import { useUserRole } from './hooks/useUserRole'
import { usePersonSearch } from './hooks/usePersonSearch'
import { useEditMode } from './hooks/useEditMode'
import { useAnnotations } from './hooks/useAnnotations'
import AnnotationToolbar from './components/annotations/AnnotationToolbar'
import TextInputOverlay from './components/annotations/TextInputOverlay'
import { filiations, getChildren, getParents, getPersonUnions, medias, persons, unions } from './data/mockData'
import { readGedcomFile } from './utils/gedcomText'
import { readGedcomBundle, zipErrorMessage } from './utils/gedcomBundle.js'
import { materializeFile } from './utils/zipReader.js'
import { loadMediaRefs, loadPhotoRefs, pickFirstFaces, prepareImageForUpload, saveMediaRefs, savePhotoRefs, sizeBucket } from './utils/photoImport'
import { fileToBase64, getAccountErrorMessage } from './utils/errorMessages'
import { getSiblingParentLinks } from './utils/familyLinks'
import { getUploadMimeType, inferMediaTypeFromMimeType, validateMediaFile } from './utils/mediaUpload'
import {
  getSource,
  identifyUser,
  resetUser,
  toInteractionMediaType,
  toJourneyRole,
  toOpaqueTreeId,
  trackAppEvent,
} from './utils/analytics'
import './App.css'
import './styles/pz.css'
import { setBooting } from './bootSignal.js'
import { saveContributorName } from './utils/contributorName'

function yearToIsoDate(value) {
  if (value === null || value === undefined || value === '') {
    return null
  }

  const raw = String(value).trim()

  // If user provided a full date YYYY-MM-DD, keep it.
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    return raw
  }

  const year = Number.parseInt(raw.slice(0, 4), 10)
  if (!Number.isFinite(year)) {
    return null
  }

  return `${String(year).padStart(4, '0')}-01-01`
}

function extractYearFromIsoDate(value) {
  if (!value || typeof value !== 'string') return null
  const year = Number.parseInt(value.slice(0, 4), 10)
  return Number.isFinite(year) ? year : null
}

function normalizeSlug(value) {
  return String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

function generateSecurePassword() {
  if (typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID().replace(/-/g, '')
  }
  // crypto.randomUUID n'est exposé qu'en contexte sécurisé (HTTPS ou localhost) :
  // sur du HTTP simple, getRandomValues reste disponible et donne le même UUID v4.
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  bytes[6] = (bytes[6] & 0x0f) | 0x40
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
}

function getAccountSelfPersonStorageKey(userEmail, treeId) {
  return `account_self_person_${userEmail || 'unknown'}_${treeId || 'none'}`
}

function buildContributionChangesFromDraft(draft = {}) {
  const changes = []
  const relationTypeToCanonical = (relation) => {
    if (!relation || !relation.sourcePersonId || !relation.targetPersonId) {
      return null
    }

    const sourcePersonId = String(relation.sourcePersonId)
    const targetPersonId = String(relation.targetPersonId)
    const relationType = String(relation.relationType || '')

    if (relationType === 'spouse') {
      const ordered = [sourcePersonId, targetPersonId].sort()
      return {
        relationType: 'spouse',
        sourcePersonId,
        targetPersonId,
        key: `spouse:${ordered[0]}:${ordered[1]}`,
      }
    }

    if (relationType === 'parent' || relationType === 'child') {
      const parentPersonId = relationType === 'parent' ? targetPersonId : sourcePersonId
      const childPersonId = relationType === 'parent' ? sourcePersonId : targetPersonId
      return {
        relationType: 'parent_child_link',
        parentPersonId,
        childPersonId,
        key: `parent_child:${parentPersonId}:${childPersonId}`,
      }
    }

    return null
  }

  const resolveRemovedRelationEntity = (canonicalRelation) => {
    if (!canonicalRelation) {
      return null
    }

    if (canonicalRelation.relationType === 'spouse') {
      const union = unions.find((candidate) => (
        (String(candidate.partner1Id) === canonicalRelation.sourcePersonId
          && Str…23677 tokens truncated…es photos : le .ged s'importe, les photos attendent l'étape des visages
          let bundle
          try {
            bundle = await readGedcomBundle(payload.gedcomFile)
          } catch (error) {
            throw new Error(error?.code === 'no_gedcom' ? error.message : zipErrorMessage(error), { cause: error })
          }
          bundledFiles = bundle.bundledFiles
          const content = (await readGedcomFile(bundle.gedcomFile)).text
          imported = content.trim()
            ? await importGedcom(createdTree.id, content, token)
            : null
          if (!imported) importError = t('Le fichier GEDCOM est vide.')
        } catch (error) {
          importError = (error?.cause && error.message) || getAccountErrorMessage(error) || t("Impossible d'importer ce fichier GEDCOM.")
        }

        await auth.loadAccountTrees(token)
        await tree.openTreeGraph(createdTree.id, token, {
          treeName: createdTree.name || payload.treeName,
          treeDescription: createdTree.description || '',
          role: 'owner',
          accessMode: 'member',
          rootPersonId: null,
          promptWizard: false,
        })
        await auth.persistLastOpenedTree({ treeId: createdTree.id, accessMode: 'member' })
        setTreeWizardVisible(false)

        if (imported) {
          const refs = Array.isArray(imported.photoRefs) ? imported.photoRefs : []
          const mediaRefs = Array.isArray(imported.mediaRefs) ? imported.mediaRefs : []
          savePhotoRefs(createdTree.id, refs)
          saveMediaRefs(createdTree.id, mediaRefs)
          trackAppEvent('gedcom_imported', {
            persons: sizeBucket(imported.personsCreated || 0),
            photo_refs: sizeBucket(refs.length),
            media_refs: sizeBucket(mediaRefs.length),
            via: 'wizard',
          })
          openPhotoStart({ personsImported: (imported.personsCreated || 0) + (imported.personsReused || 0), refs, mediaRefs, bundledFiles })
        } else {
          // L'arbre existe déjà : on l'ouvre vide et on dit où réessayer, plutôt que d'en créer un second
          setTreeImportError(importError)
        }
        return null
      }

      const createdSelf = await createPerson(
        createdTree.id,
        {
          firstName: payload.selfFirstName,
          lastName: payload.selfLastName,
          birthDate: yearToIsoDate(payload.selfBirthYear),
        },
        token,
      )

      if (createdSelf?.id) {
        await updateTree(
          createdTree.id,
          { rootPersonId: createdSelf.id },
          token,
        )

        if (payload.photoFile) {
          const validationError = validateMediaFile(payload.photoFile, 'photo')
          if (!validationError) {
            try {
              const dataBase64 = await fileToBase64(payload.photoFile)
              await uploadPersonAvatar(
                createdTree.id,
                createdSelf.id,
                {
                  fileName: payload.photoFile.name || 'avatar.jpg',
                  mimeType: getUploadMimeType(payload.photoFile, 'photo'),
                  sizeBytes: payload.photoFile.size,
                  dataBase64,
                },
                token,
              )
            } catch {
              // La photo est optionnelle: ignorer l'echec sans bloquer la creation.
            }
          }
        }
      }

      await auth.loadAccountTrees(token)
      await tree.openTreeGraph(createdTree.id, token, {
        treeName: createdTree.name || payload.treeName,
        treeDescription: createdTree.description || '',
        role: 'owner',
        accessMode: 'member',
        rootPersonId: createdSelf?.id || null,
        promptWizard: false,
      })
      await auth.persistLastOpenedTree({
        treeId: createdTree.id,
        accessMode: 'member',
      })

      setTreeWizardVisible(false)
      setTreeWelcomeVisible(true)
      return null
    } catch (error) {
      const message = getAccountErrorMessage(error)
      auth.setAccountError(message)
      return message
    } finally {
      auth.setAccountLoading(false)
      setTreeWizardLoading(false)
    }
  }

  const handleLogout = async () => {
    setTreeNotFound(false)
    await auth.handleLogout()
    resetSignedOutState()
  }

  // Suppression du compte : même remise à zéro que la déconnexion une fois la session effacée.
  const handleDeleteAccount = async (password) => {
    const errorMessage = await auth.handleDeleteAccount(password)
    if (errorMessage) {
      return errorMessage
    }

    setTreeNotFound(false)
    resetSignedOutState()
    return null
  }

  function resetSignedOutState() {
    setAccountFromTree(false)
    tree.setWizardState({ visible: false, loading: false, error: '' })
    setAccountPanelVisible(false)
    setTreeWizardVisible(false)
    setTreeWelcomeVisible(false)
    setAccountEntryMode('login')
    media.resetMediaManager()
    setAdminPanelVisible(false)
    contrib.resetContribState()
    tree.setBootState('account')
  }

  const handleGateUnlock = async (treeId, password) => {
    const access = await tree.handleUnlock(treeId, password, {
      userToken: auth.userAuth.token || '',
      treeName: tree.treeContext.treeName,
      treeDescription: tree.treeContext.treeDescription,
      treeOwnerName: tree.treeContext.treeOwnerName,
      treeOwnerEmail: tree.treeContext.treeOwnerEmail,
    })

    if (!access) {
      return
    }

    setTreeNotFound(false)
    if (auth.userAuth.token) {
      await auth.loadAccountTrees(auth.userAuth.token)
      auth.persistLastOpenedTree({
        treeId,
        accessMode: 'share',
      })
    }
  }

  const handleTreeDeleted = async (deletedTreeId) => {
    if (!auth.userAuth.token) {
      handleUseAccount('login')
      return
    }

    try {
      const { trees, lastOpenedTree } = await auth.loadAccountTrees(auth.userAuth.token)

      const preferredTree = lastOpenedTree
        ? trees.find((entry) =>
          String(entry.id) === String(lastOpenedTree.treeId)
          && (!lastOpenedTree.accessMode || entry.accessMode === lastOpenedTree.accessMode))
        : null

      const nextTree = trees.find((entry) => String(entry.id) !== String(deletedTreeId)) || preferredTree || trees[0] || null
      if (nextTree) {
        await openAccountTree(nextTree, auth.userAuth.token, { promptWizard: true })
        return
      }

      handleUseDemo()
      setAccountEntryMode('register')
      setTreeWizardVisible(true)
    } catch {
      tree.setBootState('account')
    }
  }

  const handleGedcomImported = useCallback(async (result, treeIdOverride = null, bundledFiles = []) => {
    await refreshTreeAndKeepSelection(null, { relayout: true })
    const refs = Array.isArray(result?.photoRefs) ? result.photoRefs : []
    const mediaRefs = Array.isArray(result?.mediaRefs) ? result.mediaRefs : []
    savePhotoRefs(treeIdOverride || tree.treeContext.treeId, refs)
    saveMediaRefs(treeIdOverride || tree.treeContext.treeId, mediaRefs)
    trackAppEvent('gedcom_imported', {
      persons: sizeBucket(result?.personsCreated || 0),
      photo_refs: sizeBucket(refs.length),
      media_refs: sizeBucket(mediaRefs.length),
    })
    setAdminPanelVisible(false)
    openPhotoStart({ personsImported: (result?.personsCreated || 0) + (result?.personsReused || 0), refs, mediaRefs, bundledFiles })
  }, [refreshTreeAndKeepSelection, openPhotoStart, tree.treeContext.treeId])

  // Un portrait envoyé sans recharger l'arbre (rechargé une fois, à la fermeture de la fenêtre).
  // Renvoie un message d'erreur, ou '' si c'est fait.
  const sendPortrait = useCallback(async (personId, file) => {
    const accessToken = tree.treeContext.accessToken || auth.userAuth.token
    if (!accessToken || !tree.treeContext.treeId) return t('Session expirée, reconnectez-vous.')
    // Photo d'un zip : décompressée seulement maintenant
    const prepared = await prepareImageForUpload(await materializeFile(file))
    const validationError = validateMediaFile(prepared, 'photo')
    if (validationError) return validationError
    const payload = {
      fileName: prepared.name || 'avatar.jpg',
      mimeType: getUploadMimeType(prepared, 'photo'),
      sizeBytes: prepared.size,
      dataBase64: await fileToBase64(prepared),
    }
    // Trop d'envois d'un coup (429) : on attend et on réessaie, deux fois au plus
    for (let attempt = 0; ; attempt += 1) {
      try {
        await uploadPersonAvatar(tree.treeContext.treeId, personId, payload, accessToken)
        photoStartDirtyRef.current = true
        return ''
      } catch (error) {
        if (error?.status === 429 && attempt < 2) {
          await new Promise((resolve) => window.setTimeout(resolve, 15000))
          continue
        }
        return getAccountErrorMessage(error)
      }
    }
  }, [auth.userAuth.token, tree.treeContext.accessToken, tree.treeContext.treeId])

  const handlePhotoStartUploadOne = useCallback(async (personId, file) => {
    const error = await sendPortrait(personId, file)
    if (!error) trackAppEvent('portrait_added', { via: 'first_faces' })
    return error
  }, [sendPortrait])

  const handlePhotoStartBulk = useCallback(async (matches, onProgress) => {
    const placedIds = []
    for (let i = 0; i < matches.length; i += 1) {
      const error = await sendPortrait(matches[i].personId, matches[i].file)
      if (!error) placedIds.push(matches[i].personId)
      onProgress?.(i + 1)
    }
    trackAppEvent('portraits_bulk_placed', { placed: sizeBucket(placedIds.length), failed: sizeBucket(matches.length - placedIds.length) })
    return { placedIds }
  }, [sendPortrait])

  // Les autres fichiers retrouvés dans le dossier : des souvenirs, avec le titre et la source du logiciel
  const handlePhotoStartMedia = useCallback(async (matches, onProgress) => {
    const accessToken = tree.treeContext.accessToken || auth.userAuth.token
    const added = []
    for (let i = 0; i < matches.length; i += 1) {
      const { personId, caption, source } = matches[i]
      try {
        if (!accessToken || !tree.treeContext.treeId) break
        const file = await materializeFile(matches[i].file)
        const prepared = await prepareImageForUpload(file)
        const type = inferMediaTypeFromMimeType(prepared.type)
        if (!validateMediaFile(prepared, type)) {
          const payload = {
            type,
            fileName: prepared.name || file.name,
            mimeType: getUploadMimeType(prepared, type),
            sizeBytes: prepared.size,
            dataBase64: await fileToBase64(prepared),
            caption: caption ? String(caption).slice(0, 280) : null,
            source: source ? String(source).slice(0, 500) : null,
          }
          // Trop d'envois d'un coup (429) : on attend et on réessaie, deux fois au plus
          for (let attempt = 0; ; attempt += 1) {
            try {
              await uploadPersonMedia(tree.treeContext.treeId, personId, payload, accessToken)
              added.push(matches[i])
              photoStartDirtyRef.current = true
              break
            } catch (error) {
              if (error?.status === 429 && attempt < 2) {
                await new Promise((resolve) => window.setTimeout(resolve, 15000))
                continue
              }
              break
            }
          }
        }
      } catch {
        // Fichier illisible : compté comme non envoyé
      }
      onProgress?.(i + 1)
    }
    trackAppEvent('memories_bulk_added', { added: sizeBucket(added.length), failed: sizeBucket(matches.length - added.length) })
    return { added }
  }, [auth.userAuth.token, tree.treeContext.accessToken, tree.treeContext.treeId])

  const handlePhotoStartClose = useCallback(async () => {
    setPhotoStart((current) => ({ ...current, visible: false }))
    if (photoStartDirtyRef.current) {
      photoStartDirtyRef.current = false
      await refreshTreeAndKeepSelection(null, { relayout: true, avatarCacheBust: Date.now() })
    }
  }, [refreshTreeAndKeepSelection])

  const handleSelectSelfPerson = (personId) => {
    const treeId = tree.treeContext.treeId
    if (!treeId || !accountEmail) {
      return
    }

    const nextValue = personId ? String(personId) : ''
    setLinkedSelfPersonId(nextValue)

    try {
      const storageKey = getAccountSelfPersonStorageKey(accountEmail, treeId)
      if (nextValue) {
        localStorage.setItem(storageKey, nextValue)
      } else {
        localStorage.removeItem(storageKey)
      }
    } catch {
      // Ignore storage failures
    }
  }


  if (tree.bootState === 'loading') {
    return (
      <div className="app app-loading" />
    )
  }

  if (tree.bootState === 'need-access') {
    return (
      <div className="app">
        <AccessGate
          initialTreeId={tree.treeContext.treeId}
          treeName={tree.treeContext.treeName}
          treeDescription={tree.treeContext.treeDescription}
          treeOwnerName={tree.treeContext.treeOwnerName}
          treeOwnerEmail={tree.treeContext.treeOwnerEmail}
          treeNotFound={treeNotFound}
          loading={tree.gateLoading}
          errorMessage={tree.gateError}
          onSubmit={handleGateUnlock}
          onUseDemo={handleUseDemo}
          onUseAccount={handleUseAccount}
        />
      </div>
    )
  }

  if (tree.bootState === 'account') {
    return (
      <div className="app">
        <AccountDashboard
          authenticated={auth.authenticated}
          loading={auth.accountLoading}
          errorMessage={auth.accountError}
          trees={auth.accountTrees}
          activeTreeId={tree.treeContext.treeId}
          defaultMode={accountEntryMode}
          pendingTreeName={pendingSharedTreeName}
          onLogin={handleLogin}
          onRegister={handleRegister}
          onOpenTree={handleOpenTreeFromAccount}
          onStartTreeWizard={handleOpenTreeWizard}
          onLogout={handleLogout}
          onDeleteAccount={handleDeleteAccount}
          onBackToAccess={handleBackToAccess}
          onBackToTree={accountFromTree ? handleBackToTree : undefined}
          onUseDemo={handleUseDemo}
        />
      </div>
    )
  }

  const isEmptyTree = persons.length === 0
    && !!tree.treeContext.treeId
    && tree.canEditCurrentTree
    && tree.treeContext.accessMode !== 'demo'

  return (
    <div className="app">
      {/* Bannière de bienvenue (premier utilisateur, mode démo) */}
      {treeWelcomeVisible && (
        <div className="tree-created-prompt" role="status">
          <strong>{t('Votre arbre est créé.')}</strong>
          {t("Ajoutez un proche pour commencer, comme votre mère, votre père ou un frère. Il suffit d'un prénom.")}
          <button type="button" onClick={() => setTreeWelcomeVisible(false)} aria-label={t('Fermer')}>
            {t('Fermer')}
          </button>
        </div>
      )}
      {treeImportError && (
        <div className="tree-created-prompt tree-created-prompt--error" role="alert">
          <strong>{t("Votre arbre est créé, mais l'import n'a pas abouti.")}</strong>
          {` ${treeImportError} `}
          {t("Vous pouvez réessayer depuis les paramètres de l'arbre.")}
          <button type="button" onClick={() => setTreeImportError('')} aria-label={t('Fermer')}>
            {t('Fermer')}
          </button>
        </div>
      )}
      {/* Bouton premier ajout (arbre vide) */}
      {isEmptyTree && (
        <button
          type="button"
          className="empty-tree-add"
          onClick={() => { editMode.activate(); handleOpenAddPerson() }}
          aria-label={t('Ajouter une première personne')}
        >
          <svg className="empty-tree-add-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden="true">
            <circle cx="12" cy="12" r="10" />
            <line x1="12" y1="8" x2="12" y2="16" />
            <line x1="8" y1="12" x2="16" y2="12" />
          </svg>
          <div className="empty-tree-add-body">
            <span className="empty-tree-add-title">{t('Ajouter une personne')}</span>
            <span className="empty-tree-add-hint">{t("Commencer l'arbre")}</span>
          </div>
          <svg className="empty-tree-add-chevron" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <polyline points="6 4 10 8 6 12" />
          </svg>
        </button>
      )}
      {/* Recherche Expandable */}
      <ExpandableSearch
        results={search.results}
        hasResults={search.hasResults}
        onSearch={search.handleSearch}
        onClear={search.clearSearch}
        onResultClick={(person) => {
          const fullPerson = persons.find(p => p.id === person.id)
          if (!fullPerson) return
          trackDemoInteraction('search')
          tree.setSelectedPerson(fullPerson)
          galaxyZoomApiRef.current?.focusPerson?.(fullPerson.id)
        }}
      />
      {/* Draft Restore Banner (au reload si draft trouvé) */}
      <DraftRestoreBanner
        visible={showDraftBanner && !editMode.isActive}
        draftTimestamp={editMode.draftTimestamp}
        onRestore={handleDraftRestore}
        onDiscard={handleDraftDiscard}
      />
      {/* Edit Mode Overlay */}
      <EditModeOverlay
        active={editMode.isActive}
        hasDraft={editMode.hasDraft}
        draftTimestamp={editMode.draftTimestamp}
        role={userRole.isAdmin ? 'admin' : 'contributor'}
        onDeactivate={editMode.deactivate}
        onSubmit={handleEditSubmit}
      />
      {/* Confirmation Modal (quitter mode édition avec draft) */}
      <EditConfirmModal
        visible={showConfirmModal}
        onContinue={handleConfirmContinue}
        onSaveAndQuit={handleConfirmSaveAndQuit}
        onDiscard={handleConfirmDiscard}
      />
      {/* Slide-in Ajouter Personne */}
      <AddPersonPanel
        visible={addPersonPanelVisible && editMode.isActive}
        persons={persons}
        loading={addPersonLoading}
        error={addPersonError}
        onSubmit={handleAddPersonSubmit}
        onClose={handleCloseAddPerson}
      />
      {/* Modal Session Contribution (contributeurs) */}
      <ContributionSessionModal
        visible={showContribModal}
        changes={contribChanges}
        recap={(() => {
          const d = editMode.restoreDraft()
          return {
            added: (d.addedPersons || []).length + (d.addedAnnotations || []).length,
            modified: Object.keys(d.modifiedPersons || {}).length + (d.modifiedAnnotations || []).length,
            deleted: (d.deletedPersons || []).length + (d.deletedAnnotations || []).length,
          }
        })()}
        loading={contribSubmitLoading}
        error={contribSubmitError}
        askName={!auth.userAuth.user?.name}
        onSubmit={handleContribSessionSubmit}
        onCancel={() => setShowContribModal(false)}
      />
      {/* Toast succès contribution */}
      <FamilyWelcome
        visible={familyWelcomeVisible && !souvenirPickerVisible}
        treeName={tree.treeContext.treeName}
        onAddSouvenir={handleOpenSouvenirPicker}
        onLook={closeFamilyWelcome}
      />
      <SouvenirPicker
        visible={souvenirPickerVisible}
        persons={persons}
        rootPersonId={tree.treeContext.rootPersonId}
        onPick={handleSouvenirPick}
        onAddPerson={handleSouvenirPickerAddPerson}
        onClose={() => setSouvenirPickerVisible(false)}
      />
      {draftNotice && !contribSuccess && !showContribModal && (
        <div className="contrib-success-toast" role="status">{draftNotice}</div>
      )}
      {contribSuccess && (
        <div className="contrib-success-toast" role="status">
          {t("Merci, c'est envoyé ! Ça apparaîtra dans l'arbre une fois relu.")}
        </div>
      )}
      {/* Navbar contextuelle */}
      <ContextualNavbar
        userRole={userRole}
        pendingContributions={contrib.contribState.sessions?.length || 0}
        editModeActive={editMode.isActive}
        trees={auth.accountTrees}
        activeTreeId={tree.treeContext.treeId}
        onEditClick={handleEditToggle}
        onAddPersonClick={handleOpenAddPerson}
        onAddSouvenirClick={isFamilyVisitor ? handleOpenSouvenirPicker : undefined}
        helpUrl={isFamilyVisitor ? HELP_URL : ''}
        onShareClick={userRole.isAdmin ? handleOpenContributionPanel : undefined}
        onTreeSelect={handleOpenTreeFromAccount}
        onCreateTree={handleOpenTreeWizard}
        onProfileClick={handleUseAccount}
        onAccountClick={() => setAccountPanelVisible(true)}
        onSettingsClick={() => setAdminPanelVisible(true)}
        onLogout={handleLogout}
        userDisplayName={accountDisplayName}
        userEmail={accountEmail}
        userAvatarPhoto={accountAvatarPhoto}
        linkedPersonName={linkedSelfPerson ? `${linkedSelfPerson.firstName || ''} ${linkedSelfPerson.lastName || ''}`.trim() : ''}
        activeTreeName={activeAccountTreeName}
        annotationTools={editMode.isActive ? {
          activeTool: annot.activeTool,
          onToolChange: annot.setActiveTool,
          currentStyle: annot.currentStyle,
          onStyleChange: annot.setCurrentStyle,
          selectedAnnotationId: annot.selectedAnnotationId,
          selectedSticker: annot.selectedSticker,
          onStickerSelect: annot.setSelectedSticker,
          onDelete: annot.deleteSelectedAnnotation,
          isDragging: annot.isDragging,
          isOverTrash: annot.isOverTrash,
          onPhotoFileSelected: handleAnnotationPhotoFile,
        } : null}
      />
      <Galaxy
        onPersonSelect={handlePersonSelect}
        onMediaSelect={handleMediaSelectFresh}
        selectedPersonId={tree.selectedPerson?.id || null}
        searchHighlightIds={search.matchedPersonIds}
        graphRevision={tree.graphRevision}
        annotationHandlers={editMode.isActive ? annot : null}
        transformReadRef={galaxyTransformReadRef}
        zoomApiRef={galaxyZoomApiRef}
        focusPersonId={tree.treeContext.rootPersonId}
        assetRevision={tree.assetRevision}
        photoHint={tree.canEditCurrentTree}
        reorderEnabled={canReorderSiblings}
        onReorderSiblings={handleReorderSiblings}
      />
      <ZoomControl zoomApiRef={galaxyZoomApiRef} />
      {tree.selectedPerson && (
        <PersonCard
          person={tree.selectedPerson}
          onClose={() => tree.setSelectedPerson(null)}
          onMediaSelect={handleMediaSelectFresh}
          editMode={editMode.isActive}
          canManageMedia={tree.canSubmitContribution || tree.canEditCurrentTree}
          onManageMedia={media.handleOpenMediaManager}
          onAvatarUpload={tree.canEditCurrentTree ? handlePersonAvatarUpload : undefined}
          onAvatarDelete={tree.canEditCurrentTree ? handlePersonAvatarDelete : undefined}
          treeId={tree.treeContext.treeId || null}
          immichToken={tree.treeContext.accessToken || auth.userAuth.token}
          onImmichChange={tree.canEditCurrentTree ? handleImmichChange : undefined}
          avatarActionLoading={avatarActionState.loading}
          avatarActionError={avatarActionState.error}
          isAdmin={userRole.isAdmin}
          onSave={handlePersonSave}
          onDelete={handlePersonDelete}
          onAddRelation={handleAddRelation}
          onRemoveRelation={handleRemoveRelation}
          relationActionLoading={relationFeedback.loading}
          relationActionSuccess={relationFeedback.success}
          relationActionError={relationFeedback.error}
          siblingPlace={siblingPlace}
          onMoveSibling={(delta) => galaxyZoomApiRef.current?.moveSibling?.(tree.selectedPerson.id, delta)}
          onUploadMomentFile={tree.canEditCurrentTree || tree.canSubmitContribution ? media.uploadMomentFile : undefined}
          onMomentSaved={media.refreshMomentMedia}
        />
      )}
      {tree.selectedMedia && (
        <MediaViewer
          media={tree.selectedMedia.media}
          person={tree.selectedMedia.person}
          onClose={() => tree.setSelectedMedia(null)}
        />
      )}
      <MediaManagerPanel
        treeId={tree.treeContext.treeId}
        token={tree.treeContext.accessToken || auth.userAuth.token}
        visible={media.mediaManagerState.visible}
        person={tree.selectedPerson}
        medias={media.selectedPersonMedias}
        loading={media.mediaManagerState.loading}
        errorMessage={media.mediaManagerState.error}
        notice={media.mediaManagerState.notice}
        canManage={tree.canEditCurrentTree}
        onClose={media.handleCloseMediaManager}
        onUpload={media.handleUploadPersonMedia}
        onMove={media.handleMovePersonMedia}
        onDelete={media.handleDeletePersonMedia}
      />
      <ContributionPanel
        visible={contrib.contribState.visible}
        treeId={tree.treeContext.treeId}
        canModerate={tree.canEditCurrentTree}
        loading={contrib.contribState.loading}
        errorMessage={contrib.contribState.error}
        inviteShareUrl={contribInviteState.shareUrl}
        inviteKnownPasswords={contribInviteState.knownPasswords}
        inviteSaving={contribInviteState.loading}
        inviteError={contribInviteState.error}
        inviteMessage={contribInviteState.message}
        sessions={contrib.contribState.sessions}
        reviewingSessionId={contrib.contribState.reviewingSessionId}
        onClose={contrib.handleCloseContributionPanel}
        onRefresh={contrib.refreshContributionSessions}
        onRotatePasswords={handleContributionPasswordRotate}
        onRememberPassword={handleContributionPasswordRemember}
        onReviewSession={contrib.handleReviewContributionSession}
      />
      <AccountPanel
        visible={accountPanelVisible}
        userDisplayName={accountDisplayName}
        userEmail={accountEmail}
        linkedPerson={linkedSelfPerson}
        selectedPersonId={linkedSelfPersonId}
        people={persons}
        onSelectPerson={handleSelectSelfPerson}
        onManageAccount={() => handleUseAccount('login')}
        onClose={() => setAccountPanelVisible(false)}
      />
      <AdminPanel
        visible={adminPanelVisible}
        treeId={tree.treeContext.treeId}
        authToken={tree.treeContext.accessToken}
        isAdmin={userRole.isAdmin}
        onTreeDeleted={handleTreeDeleted}
        onGedcomImported={handleGedcomImported}
        onOpenPhotoStart={() => { setAdminPanelVisible(false); openPhotoStart() }}
        onClose={() => setAdminPanelVisible(false)}
      />
      <PhotoStartPanel
        visible={photoStart.visible}
        personsImported={photoStart.personsImported}
        photoRefs={photoStart.refs}
        mediaRefs={photoStart.mediaRefs}
        bundledFiles={photoStart.bundledFiles}
        faces={photoStart.faces}
        onUploadOne={handlePhotoStartUploadOne}
        onBulkPlace={handlePhotoStartBulk}
        onBulkMedia={handlePhotoStartMedia}
        onRefsChange={(refs) => savePhotoRefs(tree.treeContext.treeId, refs)}
        onMediaRefsChange={(refs) => saveMediaRefs(tree.treeContext.treeId, refs)}
        onClose={handlePhotoStartClose}
      />
      {/* Annotation Toolbar (visible uniquement en mode édition) */}
      {editMode.isActive && (
        <AnnotationToolbar
          activeTool={annot.activeTool}
          onToolChange={annot.setActiveTool}
          currentStyle={annot.currentStyle}
          onStyleChange={annot.setCurrentStyle}
          selectedAnnotationId={annot.selectedAnnotationId}
          selectedAnnotation={annot.selectedAnnotation}
          selectedSticker={annot.selectedSticker}
          onStickerSelect={annot.setSelectedSticker}
          onDelete={annot.deleteSelectedAnnotation}
          onResizeSelected={annot.resizeSelected}
          onPhotoFileSelected={handleAnnotationPhotoFile}
          isDragging={annot.isDragging}
          isOverTrash={annot.isOverTrash}
        />
      )}
      {/* Text Input Overlay (saisie texte sur canvas) */}
      <TextInputOverlay
        textInputState={annot.textInputState}
        currentStyle={annot.currentStyle}
        onCommit={annot.commitTextInput}
        onCancel={annot.cancelTextInput}
      />
      {/* Onboarding premier arbre */}
      <TreeCreationWizard
        visible={treeWizardVisible}
        loading={treeWizardLoading}
        defaultFirstName={accountDisplayName}
        onClose={() => setTreeWizardVisible(false)}
        onSubmit={handleCreateTreeFromWizard}
      />
    </div>
  )
}

export default App




