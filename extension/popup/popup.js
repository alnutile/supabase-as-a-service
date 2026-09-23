// The popup: connect once, then save the tab you are looking at.
//
// All of the interesting logic lives in ../lib/* so it can be unit-tested
// (`npm test` covers extension/lib/*.test.js); this file is wiring - read the
// tab, ask the user what they want, call the workspace, report what happened.
import { createClient } from '../lib/api.js'
import { buildArtifactBody, extractArticle } from '../lib/extract.js'
import { appLink, cleanTitle, displayUrl, normalizeBaseUrl, siteAliases } from '../lib/parse.js'
import { DEFAULTS, isConnected, loadSettings, saveSettings } from '../lib/settings.js'

const $ = (id) => document.getElementById(id)
const NEW_COLLECTION = '__new__'

/** Everything the popup learns about the current tab, once. */
const state = {
  settings: { ...DEFAULTS },
  tab: null,
  /** @type {import('../lib/extract.js').Extraction | null} */
  article: null,
  /** The in-flight read of the page, so a fast Save waits for it. */
  capture: Promise.resolve(),
  captureError: '',
}

init().catch((e) => setStatus($('saveStatus'), `Something went wrong: ${e.message}`, 'err'))

async function init() {
  state.settings = await loadSettings()
  $('gear').addEventListener('click', () => showSetup(true))
  $('connect').addEventListener('click', connect)
  $('cancelSetup').addEventListener('click', () => showSetup(false))
  $('saveBtn').addEventListener('click', save)
  $('collection').addEventListener('change', onCollectionChange)
  for (const radio of document.querySelectorAll('input[name="mode"]')) {
    radio.addEventListener('change', onModeChange)
  }

  if (!isConnected(state.settings)) {
    showSetup(true)
    return
  }
  await showSave()
}

// --- Connection -------------------------------------------------------------

function showSetup(show) {
  $('setup').hidden = !show
  $('save').hidden = show
  if (!show) return
  $('baseUrl').value = state.settings.baseUrl
  $('token').value = state.settings.token
  $('appUrl').value = state.settings.appUrl
  $('cancelSetup').hidden = !isConnected(state.settings)
  setStatus($('setupStatus'), '')
  $(state.settings.baseUrl ? 'token' : 'baseUrl').focus()
}

async function connect() {
  const baseUrl = normalizeBaseUrl($('baseUrl').value)
  const token = $('token').value.trim()
  if (!baseUrl) return setStatus($('setupStatus'), 'That does not look like a project URL.', 'err')
  if (!token) return setStatus($('setupStatus'), 'Paste a connection token.', 'err')

  $('connect').disabled = true
  setStatus($('setupStatus'), 'Checking...')
  try {
    const { toolCount, canSaveLinks } = await createClient({ baseUrl, token }).verify()
    state.settings = { ...state.settings, baseUrl, token, appUrl: normalizeBaseUrl($('appUrl').value) }
    await saveSettings({ baseUrl, token, appUrl: state.settings.appUrl })
    setStatus(
      $('setupStatus'),
      canSaveLinks
        ? `Connected. ${toolCount} tools available.`
        : `Connected, but the "save_link" tool is not active - an admin can enable it on the Tools page. Saving as an article still works.`,
      'ok',
    )
    await showSave()
  } catch (e) {
    setStatus($('setupStatus'), e.message, 'err')
  } finally {
    $('connect').disabled = false
  }
}

// --- Saving -----------------------------------------------------------------

async function showSave() {
  $('setup').hidden = true
  $('save').hidden = false

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
  state.tab = tab ?? null
  const url = tab?.url ?? ''
  $('pageUrl').textContent = displayUrl(url) || 'No page'
  $('title').value = cleanTitle(tab?.title ?? '', siteAliases('', url))

  selectMode(state.settings.lastMode === 'link' ? 'link' : 'article')
  // Both round-trips start at once: neither needs the other's answer, and the
  // popup should be usable the moment it opens.
  loadCollections()
  state.capture = captureArticle()
  await state.capture
}

/**
 * Read the tab's rendered HTML and turn it into markdown. This happens on open
 * rather than on save so the word count (and the preview) can tell you whether
 * the clipper actually found the article BEFORE you commit it.
 *
 * `activeTab` is granted by the click that opened this popup, so no broad host
 * permission is needed - and nothing is injected until you ask for a page.
 */
async function captureArticle() {
  const meta = $('articleMeta')
  const url = state.tab?.url ?? ''
  if (!state.tab?.id || !/^https?:/i.test(url)) {
    state.captureError = 'Chrome will not let an extension read this page.'
    meta.textContent = state.captureError
    selectMode('link')
    return
  }
  try {
    const [injected] = await chrome.scripting.executeScript({
      target: { tabId: state.tab.id },
      // Deliberately trivial: hand back the rendered HTML and let the popup do
      // the thinking, so the parsing logic stays testable outside Chrome.
      func: () => ({ html: document.documentElement.outerHTML, url: location.href }),
    })
    const payload = injected?.result
    if (!payload?.html) throw new Error('The page returned nothing.')
    state.article = extractArticle(payload.html, payload.url || url)
    if (state.article.title) $('title').value = state.article.title
    meta.textContent = state.article.thin
      ? `only ${state.article.words} words found - check the preview`
      : `${state.article.words.toLocaleString()} words of markdown, no page furniture`
    $('preview').hidden = false
    $('previewBody').textContent = state.article.markdown.slice(0, 4000)
  } catch (e) {
    state.captureError = `Could not read the page (${e.message}).`
    meta.textContent = state.captureError
    selectMode('link')
  }
}

async function loadCollections() {
  const select = $('collection')
  try {
    const collections = await client().listCollections()
    select.innerHTML = ''
    select.append(new Option('No collection', ''))
    for (const c of collections) {
      const label = c.visibility === 'workspace' ? `${c.name} (team)` : c.name
      select.append(new Option(label, c.id))
    }
    select.append(new Option('+ New collection...', NEW_COLLECTION))
    if (state.settings.lastCollection && collections.some((c) => c.id === state.settings.lastCollection)) {
      select.value = state.settings.lastCollection
    }
  } catch (e) {
    select.innerHTML = ''
    select.append(new Option('Could not load collections', ''))
    select.append(new Option('+ New collection...', NEW_COLLECTION))
    setStatus($('saveStatus'), e.message, 'err')
  }
}

function onCollectionChange() {
  const isNew = $('collection').value === NEW_COLLECTION
  $('newCollection').hidden = !isNew
  if (isNew) $('newCollection').focus()
}

function onModeChange() {
  if (currentMode() === 'article' && state.captureError) {
    setStatus($('saveStatus'), `${state.captureError} Save it as a link instead.`, 'err')
    selectMode('link')
    return
  }
  setStatus($('saveStatus'), '')
}

async function save() {
  const mode = currentMode()
  const title = $('title').value.trim()
  const note = $('note').value.trim()
  const url = state.tab?.url ?? ''
  if (!url) return setStatus($('saveStatus'), 'No page to save.', 'err')
  if (!title) return setStatus($('saveStatus'), 'Give it a title.', 'err')

  const collection = chosenCollection()
  if (collection === null) return setStatus($('saveStatus'), 'Name the new collection.', 'err')

  $('saveBtn').disabled = true
  setStatus($('saveStatus'), mode === 'article' ? 'Saving the article...' : 'Saving the link...')
  try {
    // `collection` is a NAME or an id either way - both the artifacts API and
    // the save_link builtin create one that does not exist yet, so a new
    // collection needs no separate round-trip.
    if (mode === 'link') {
      const saved = await client().saveLink({ url, title, notes: note, collection })
      finish(`Saved "${saved.title}" as a link.`, appLink(state.settings.appUrl, '/links'))
    } else {
      await state.capture // a Save before the read finished waits, rather than failing
      if (!state.article) throw new Error(state.captureError || 'The page could not be read.')
      const body = buildArtifactBody({ ...state.article, title }, url)
      const content = note ? `${body}\n\n---\n\n**Note:** ${note}\n` : body
      const artifact = await client().createArtifact({
        title,
        content,
        collections: collection ? [collection] : [],
      })
      finish(
        `Saved ${state.article.words.toLocaleString()} words as an artifact.`,
        artifact?.share_url || appLink(state.settings.appUrl, `/artifacts/${artifact?.id ?? ''}`),
      )
    }
    await saveSettings({ lastMode: mode, lastCollection: $('collection').value === NEW_COLLECTION ? '' : $('collection').value })
  } catch (e) {
    setStatus($('saveStatus'), e.message, 'err')
  } finally {
    $('saveBtn').disabled = false
  }
}

function finish(message, link) {
  const status = $('saveStatus')
  status.className = 'status ok'
  status.textContent = `${message} `
  if (!link) return
  const a = document.createElement('a')
  a.href = link
  a.target = '_blank'
  a.rel = 'noreferrer'
  a.textContent = 'Open it'
  status.append(a)
}

// --- Small helpers ----------------------------------------------------------

function client() {
  return createClient({ baseUrl: state.settings.baseUrl, token: state.settings.token })
}

function currentMode() {
  return document.querySelector('input[name="mode"]:checked')?.value ?? 'article'
}

function selectMode(mode) {
  const radio = document.querySelector(`input[name="mode"][value="${mode}"]`)
  if (radio) radio.checked = true
}

/** '' for none, a name or id to file into, or null when "new" was left blank. */
function chosenCollection() {
  const value = $('collection').value
  if (value !== NEW_COLLECTION) return value
  const name = $('newCollection').value.trim()
  return name || null
}

function setStatus(el, message, kind = '') {
  el.className = `status ${kind}`.trim()
  el.textContent = message
}
